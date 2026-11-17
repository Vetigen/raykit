use std::{
    io::{self, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

use clap::{Parser, Subcommand, ValueEnum};
use raykit_core::{Error, NativeFile, Result};
use raykit_protocol::{BoundSession, MAX_COMMAND_BYTES, OpenOptions, Reply, error_json};
use serde_json::{Value, json};

#[derive(Parser)]
#[command(name = "raykit", version, about = "RayKit by Vetigen DICOM toolkit")]
struct Application {
    #[command(subcommand)]
    command: Command,
    #[arg(long, global = true)]
    sha256: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    Inspect {
        source: PathBuf,
        #[arg(long)]
        frame: Option<usize>,
    },
    Render {
        source: PathBuf,
        #[arg(long)]
        frame: usize,
        #[arg(long)]
        out: PathBuf,
        #[arg(long, requires = "width", allow_hyphen_values = true)]
        center: Option<f64>,
        #[arg(long, requires = "center")]
        width: Option<f64>,
        #[arg(long, default_value = "linear", value_enum)]
        function: Function,
        #[arg(long, conflicts_with_all = ["lut", "center"])]
        window_index: Option<usize>,
        #[arg(long, conflicts_with = "center")]
        lut: Option<usize>,
        #[arg(long)]
        invert: bool,
        #[arg(long, default_value = "gray", value_enum)]
        palette: Palette,
    },
    Sample {
        source: PathBuf,
        #[arg(long)]
        frame: usize,
        #[arg(long)]
        x: u32,
        #[arg(long)]
        y: u32,
    },
    FrameIndex {
        source: PathBuf,
        #[arg(
            long,
            required_unless_present = "proof_directory",
            conflicts_with = "proof_directory"
        )]
        out: Option<PathBuf>,
        #[arg(long, requires = "revision")]
        proof_frame: Option<usize>,
        #[arg(long, requires = "revision", conflicts_with = "proof_frame")]
        proof_directory: Option<PathBuf>,
        #[arg(long)]
        revision: Option<String>,
    },
    Tiles {
        source: PathBuf,
        #[arg(long)]
        frame: usize,
        #[arg(long)]
        directory: PathBuf,
        #[arg(long)]
        revision: String,
        #[arg(long, default_value_t = 256)]
        edge: u32,
    },
    Measurements {
        #[command(subcommand)]
        command: Measurements,
    },
}

#[derive(Subcommand)]
enum Measurements {
    Verify { source: PathBuf, record: PathBuf },
}

#[derive(Clone, ValueEnum)]
enum Function {
    Linear,
    LinearExact,
    Sigmoid,
}

#[derive(Clone, ValueEnum)]
enum Palette {
    Gray,
    Hot,
}

fn request(session: &mut BoundSession, command: Value) -> Result<Reply> {
    session.request(&serde_json::to_vec(&command).map_err(|_| Error::Internal)?)
}

fn data(reply: &Reply) -> Result<Value> {
    serde_json::from_str(&reply.metadata).map_err(|_| Error::Internal)
}

fn write_new(path: &Path, operation: impl FnOnce(&mut std::fs::File) -> Result<()>) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| Error::Io("create output in destination directory"))?;
    operation(temporary.as_file_mut())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| Error::Io("flush output"))?;
    temporary
        .persist_noclobber(path)
        .map_err(|_| Error::Io("publish new output file"))?;
    Ok(())
}

fn run(app: Application) -> Result<Value> {
    let path = match &app.command {
        Command::Inspect { source, .. }
        | Command::Render { source, .. }
        | Command::Sample { source, .. }
        | Command::FrameIndex { source, .. }
        | Command::Tiles { source, .. }
        | Command::Measurements {
            command: Measurements::Verify { source, .. },
        } => source,
    };
    let mut options = OpenOptions::default();
    options.expected_sha256 = app.sha256;
    let (mut session, inspection) = BoundSession::open_path(path, options)?;
    match app.command {
        Command::Inspect { frame, .. } => {
            let info = data(&inspection)?;
            if let Some(index) = frame {
                Ok(
                    json!({ "inspection": info, "frame": data(&request(&mut session, json!({"op":"frame_info","index":index}))?)? }),
                )
            } else {
                Ok(info)
            }
        }
        Command::Render {
            frame,
            out,
            center,
            width,
            function,
            window_index,
            lut,
            invert,
            palette,
            ..
        } => {
            let function = match function {
                Function::Linear => "linear",
                Function::LinearExact => "linear_exact",
                Function::Sigmoid => "sigmoid",
            };
            let palette = match palette {
                Palette::Gray => "gray",
                Palette::Hot => "hot",
            };
            let window = center
                .zip(width)
                .map(|(center, width)| json!({"center":center,"width":width,"function":function}));
            let voi = window_index
                .map(|index| json!({"kind":"window","index":index}))
                .or_else(|| lut.map(|index| json!({"kind":"lut","index":index})));
            let options = json!({"window":window,"voi":voi,"invert":invert,"palette":palette});
            let rendered = request(
                &mut session,
                json!({"op":"frame","index":frame,"output":"rgba","options":options}),
            )?;
            let metadata = data(&rendered)?;
            let width = metadata["format"]["columns"]
                .as_u64()
                .ok_or(Error::Internal)? as u32;
            let height = metadata["format"]["rows"].as_u64().ok_or(Error::Internal)? as u32;
            write_new(&out, |target| {
                let mut png = png::Encoder::new(target, width, height);
                png.set_color(png::ColorType::Rgba);
                png.set_depth(png::BitDepth::Eight);
                let mut writer = png
                    .write_header()
                    .map_err(|_| Error::Io("write PNG header"))?;
                writer
                    .write_image_data(&rendered.data)
                    .map_err(|_| Error::Io("write PNG pixels"))?;
                writer.finish().map_err(|_| Error::Io("finish PNG"))
            })?;
            Ok(
                json!({"format":"png","width":width,"height":height,"source":metadata["source"],"view":options}),
            )
        }
        Command::Sample { frame, x, y, .. } => data(&request(
            &mut session,
            json!({"op":"sample_at","index":frame,"x":x,"y":y}),
        )?),
        Command::FrameIndex {
            out,
            proof_frame,
            proof_directory,
            revision,
            ..
        } => {
            if let Some(directory) = proof_directory {
                let revision = revision.ok_or(Error::InvalidRequest("frame proof revision"))?;
                let first = request(
                    &mut session,
                    json!({"op":"frame_proof","index":0,"revision":revision}),
                )?;
                let metadata = data(&first)?;
                let frames = metadata["frames"].as_u64().ok_or(Error::Internal)?;
                std::fs::create_dir(&directory)
                    .map_err(|_| Error::Io("create a new proof output directory"))?;
                let mut bytes = first.data.len();
                write_new(&directory.join("0.rkp"), |file| {
                    file.write_all(&first.data)
                        .map_err(|_| Error::Io("write proof"))
                })?;
                for index in 1..frames {
                    let reply = request(
                        &mut session,
                        json!({"op":"frame_proof","index":index,"revision":revision}),
                    )?;
                    bytes += reply.data.len();
                    write_new(&directory.join(format!("{index}.rkp")), |file| {
                        file.write_all(&reply.data)
                            .map_err(|_| Error::Io("write proof"))
                    })?;
                }
                return Ok(json!({"index": metadata, "bytes": bytes}));
            }
            if proof_frame.is_none() && revision.is_some() {
                return Err(Error::InvalidRequest(
                    "revision requires a proof frame or directory",
                ));
            }
            let out = out.ok_or(Error::InvalidRequest("frame index output path"))?;
            let reply = request(
                &mut session,
                if let Some(index) = proof_frame {
                    json!({"op":"frame_proof","index":index,"revision":revision})
                } else {
                    json!({"op":"create_frame_index"})
                },
            )?;
            let metadata = data(&reply)?;
            write_new(&out, |target| {
                target
                    .write_all(&reply.data)
                    .map_err(|_| Error::Io("write frame index"))
            })?;
            Ok(json!({"index":metadata,"bytes":reply.data.len()}))
        }
        Command::Tiles {
            frame,
            directory,
            revision,
            edge,
            ..
        } => {
            let reply = request(
                &mut session,
                json!({"op":"prepare_tiles","index":frame,"edge":edge,"revision":revision}),
            )?;
            let info = data(&reply)?;
            let count = info["tiles"].as_u64().ok_or(Error::Internal)?;
            std::fs::create_dir(&directory)
                .map_err(|_| Error::Io("create a new tile output directory"))?;
            let mut bytes = reply.data.len();
            for index in 0..count {
                let tile = request(&mut session, json!({"op":"tile","index":index}))?;
                bytes += tile.data.len();
                write_new(&directory.join(format!("{index}.bin")), |target| {
                    target
                        .write_all(&tile.data)
                        .map_err(|_| Error::Io("write tile"))
                })?;
            }
            write_new(&directory.join("manifest.json"), |target| {
                target
                    .write_all(&reply.data)
                    .map_err(|_| Error::Io("write tile manifest"))
            })?;
            Ok(json!({"manifest":info,"bytes":bytes}))
        }
        Command::Measurements {
            command: Measurements::Verify { record, .. },
        } => {
            let file = NativeFile::open(&record)?;
            if file.len() > MAX_COMMAND_BYTES as u64 {
                return Err(Error::Limit("measurement JSON bytes"));
            }
            let input: Value = serde_json::from_slice(&file.read(0, file.len() as usize)?)
                .map_err(|_| Error::InvalidRequest("measurement JSON"))?;
            let (records, list) = match input {
                Value::Array(items) if (1..=128).contains(&items.len()) => (items, true),
                Value::Object(_) => (vec![input], false),
                _ => return Err(Error::InvalidRequest("measurement record or list")),
            };
            let mut verified = records
                .into_iter()
                .map(|value| {
                    data(&request(
                        &mut session,
                        json!({"op":"verify","record":value}),
                    )?)
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(if list {
                json!(verified)
            } else {
                verified.remove(0)
            })
        }
    }
}

fn main() -> ExitCode {
    match run(Application::parse()) {
        Ok(value) => match writeln!(io::stdout().lock(), "{value}") {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => ExitCode::from(4),
        },
        Err(error) => {
            let _ = writeln!(io::stderr().lock(), "{}", error_json(&error));
            ExitCode::from(match error {
                Error::InvalidRequest(_) => 2,
                Error::Integrity(_) | Error::Geometry(_) | Error::InvalidDicom(_) => 3,
                Error::Io(_) => 4,
                Error::Unsupported(_) | Error::Limit(_) => 5,
                _ => 1,
            })
        }
    }
}
