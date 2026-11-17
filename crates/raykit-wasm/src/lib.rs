use raykit_protocol::{BoundSession, BoundTiles, OpenOptions, Reply, error_json};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmReply(Reply);

#[wasm_bindgen]
impl WasmReply {
    pub fn metadata(&self) -> String {
        self.0.metadata.clone()
    }

    /// Transfers an owned copy to JavaScript. The array survives growth of linear memory.
    pub fn take_data(&mut self) -> Box<[u8]> {
        std::mem::take(&mut self.0.data).into_boxed_slice()
    }
}

fn failure(error: raykit_core::Error) -> JsValue {
    JsValue::from_str(&error_json(&error))
}

#[wasm_bindgen]
pub fn codec_hint(prefix: &[u8]) -> u8 {
    raykit_core::TransferSyntax::part10_prefix(prefix).map_or(0, |syntax| match syntax {
        raykit_core::TransferSyntax::JpegExtended => 0,
        syntax if syntax.may_require_advanced_codecs() => 2,
        _ => 1,
    })
}

#[wasm_bindgen]
pub fn engine_version() -> String {
    option_env!("RAYKIT_ENGINE_VERSION")
        .unwrap_or("unversioned")
        .into()
}

#[wasm_bindgen]
pub fn advanced_codecs() -> bool {
    cfg!(feature = "advanced-codecs")
}

#[wasm_bindgen]
pub fn capabilities() -> Result<String, JsValue> {
    raykit_protocol::capabilities()
        .map(|reply| reply.metadata)
        .map_err(failure)
}

#[wasm_bindgen]
pub struct WasmSession {
    session: BoundSession,
    inspection: String,
}

#[wasm_bindgen]
impl WasmSession {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: Box<[u8]>, options: &str) -> Result<WasmSession, JsValue> {
        let options = OpenOptions::parse(options.as_bytes()).map_err(failure)?;
        let (session, reply) = BoundSession::open(bytes.into_vec(), options).map_err(failure)?;
        Ok(Self {
            session,
            inspection: reply.metadata,
        })
    }

    #[cfg(target_arch = "wasm32")]
    pub async fn open_in_worker(bytes: Box<[u8]>, options: String) -> Result<WasmSession, JsValue> {
        let options = OpenOptions::parse(options.as_bytes()).map_err(failure)?;
        let (session, reply) = BoundSession::open_in_worker(bytes.into_vec(), options)
            .await
            .map_err(failure)?;
        Ok(Self {
            session,
            inspection: reply.metadata,
        })
    }

    pub fn inspection(&self) -> String {
        self.inspection.clone()
    }

    pub fn open_index(bytes: &[u8], pin: &str, options: &str) -> Result<WasmSession, JsValue> {
        let options = OpenOptions::parse(options.as_bytes()).map_err(failure)?;
        let (session, reply) = BoundSession::open_index(bytes, pin, options).map_err(failure)?;
        Ok(Self {
            session,
            inspection: reply.metadata,
        })
    }

    pub fn source_bytes(&self) -> usize {
        self.session.source_bytes()
    }

    pub fn open_proof(
        packet: Box<[u8]>,
        pin: &str,
        revision: &str,
        frame: usize,
        options: &str,
    ) -> Result<Self, JsValue> {
        let settings = OpenOptions::parse(options.as_bytes()).map_err(failure)?;
        let (session, reply) =
            BoundSession::open_proof(packet.into_vec(), pin, revision, frame, settings)
                .map_err(failure)?;
        Ok(Self {
            session,
            inspection: reply.metadata,
        })
    }

    pub fn stage_proof(&mut self, frame: usize, packet: Box<[u8]>) -> Result<(), JsValue> {
        self.session
            .stage_proof(frame, packet.into_vec())
            .map_err(failure)
    }

    pub fn frame_range(&self, index: usize) -> Result<Box<[u32]>, JsValue> {
        let range = self.session.frame_range(index).map_err(failure)?;
        Ok(Box::new([
            range.start as u32,
            range.end as u32,
            range.source_bytes as u32,
        ]))
    }

    pub fn stage_range(&mut self, index: usize, data: Box<[u8]>) -> Result<(), JsValue> {
        self.session
            .stage_range(index, data.into_vec())
            .map_err(failure)
    }

    pub fn clear_range(&mut self) {
        self.session.clear_range();
    }

    pub fn adopt_full_source(&mut self, full: WasmSession) -> Result<(), JsValue> {
        self.session
            .adopt_full_source(full.session)
            .map_err(failure)
    }

    pub fn append(&mut self, bytes: Box<[u8]>, options: &str) -> Result<WasmReply, JsValue> {
        let options = OpenOptions::parse(options.as_bytes()).map_err(failure)?;
        self.session
            .append(bytes.into_vec(), options)
            .map(WasmReply)
            .map_err(failure)
    }

    pub fn request(&mut self, command: &str) -> Result<WasmReply, JsValue> {
        self.session
            .request(command.as_bytes())
            .map(WasmReply)
            .map_err(failure)
    }
}

#[wasm_bindgen]
pub fn linear_memory_bytes() -> usize {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0) * 65_536
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

#[wasm_bindgen]
pub struct WasmTiles(BoundTiles);

#[wasm_bindgen]
impl WasmTiles {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8], pin: &str, revision: &str) -> Result<WasmTiles, JsValue> {
        BoundTiles::open(bytes, pin, revision)
            .map(Self)
            .map_err(failure)
    }
    pub fn info(&self) -> Result<String, JsValue> {
        self.0.info().map_err(failure)
    }
    pub fn need(&mut self, rect: &str) -> Result<Box<[u32]>, JsValue> {
        self.0
            .need(rect.as_bytes())
            .map(|indices| indices.into_iter().map(|i| i as u32).collect())
            .map_err(failure)
    }
    pub fn stage(&mut self, index: usize, bytes: Box<[u8]>) -> Result<(), JsValue> {
        self.0.stage(index, bytes.into_vec()).map_err(failure)
    }
    pub fn request(&mut self, command: &str) -> Result<WasmReply, JsValue> {
        self.0
            .request(command.as_bytes())
            .map(WasmReply)
            .map_err(failure)
    }
}
