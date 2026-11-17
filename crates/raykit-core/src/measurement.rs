use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    Error, FrameGeometry, Object, Result, Session,
    geometry::{Metric, PixelPoint},
};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceReference {
    pub sop_class_uid: String,
    pub instance_uid: String,
    pub content_sha256: String,
    pub frame_of_reference_uid: Option<String>,
    pub frame: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    Millimeter,
    Pixel,
    Degree,
    Vertebra,
    Ratio,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Quantity {
    pub name: String,
    pub value: f64,
    pub unit: Unit,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: String,
    pub method: String,
    pub version: u32,
    pub points: Vec<PixelPoint>,
    #[serde(default)]
    pub parameters: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub source: SourceReference,
    pub coordinate_system: CoordinateSystem,
    pub input: Request,
    pub calibration: Metric,
    pub values: Vec<Quantity>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinateSystem {
    SourcePixelCenters,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct MethodInfo {
    pub id: &'static str,
    pub version: u32,
    pub name: &'static str,
    pub landmarks: &'static [&'static str],
}

pub struct Context<'a> {
    pub object: Object,
    pub geometry: &'a FrameGeometry,
    pub points: &'a [PixelPoint],
}

impl Context<'_> {
    pub fn metric(&self) -> Metric {
        self.geometry
            .calibration
            .metric(self.points)
            .unwrap_or(Metric::Pixel)
    }

    pub fn projection_metric(&self) -> Metric {
        let metric = self.metric();
        if metric != Metric::Pixel {
            return metric;
        }
        self.geometry
            .detector_spacing_xy
            .map_or(Metric::Pixel, |[x, y]| Metric::DetectorAspect {
                ratio_yx: y / x,
            })
    }
}

/// Methods receive user-selected landmarks and geometry. They have no source or network access.
pub trait Method {
    fn info(&self) -> MethodInfo;
    fn evaluate(
        &self,
        context: &Context<'_>,
        parameters: &Value,
    ) -> Result<(Metric, Vec<Quantity>)>;
}

impl Session {
    pub fn source_reference(&self, frame: usize) -> Result<SourceReference> {
        if frame >= self.info.frames {
            return Err(Error::InvalidRequest("frame index"));
        }
        Ok(SourceReference {
            sop_class_uid: self.info.sop_class_uid.clone(),
            instance_uid: self.info.instance_uid.clone(),
            content_sha256: self.info.content_sha256.clone(),
            frame_of_reference_uid: self.frame_of_reference().map(str::to_owned),
            frame,
        })
    }

    pub fn measure(
        &mut self,
        frame: usize,
        request: Request,
        method: &dyn Method,
    ) -> Result<Record> {
        let source = self.source_reference(frame)?;
        let frame = self.read_frame(frame)?;
        measure_on_geometry(
            self.info.object,
            source,
            &frame.geometry,
            [frame.format.columns, frame.format.rows],
            request,
            method,
        )
    }

    pub fn reopen_measurement(&mut self, record: Record, method: &dyn Method) -> Result<Record> {
        let actual = self.source_reference(record.source.frame)?;
        if actual != record.source {
            return Err(Error::Integrity("measurement source differs"));
        }
        let recomputed = self.measure(actual.frame, record.input, method)?;
        if recomputed.calibration != record.calibration {
            return Err(Error::Integrity("measurement calibration differs"));
        }
        Ok(recomputed)
    }
}

pub(crate) fn measure_on_geometry(
    object: Object,
    source: SourceReference,
    geometry: &FrameGeometry,
    dimensions: [u32; 2],
    request: Request,
    method: &dyn Method,
) -> Result<Record> {
    let descriptor = method.info();
    if request.method != descriptor.id || request.version != descriptor.version {
        return Err(Error::Unsupported("measurement method or version"));
    }
    if request.id.is_empty()
        || request.id.len() > 128
        || request.points.is_empty()
        || request.points.len() > 128
    {
        return Err(Error::InvalidRequest("measurement ID or point count"));
    }
    check_points(dimensions, &request.points)?;
    let context = Context {
        object,
        geometry,
        points: &request.points,
    };
    let (calibration, values) = method.evaluate(&context, &request.parameters)?;
    if values.is_empty()
        || values.len() > 32
        || values.iter().any(|v| !v.value.is_finite())
        || !calibration
            .scale()
            .iter()
            .all(|n| n.is_finite() && *n != 0.0)
    {
        return Err(Error::InvalidRequest("invalid measurement result"));
    }
    Ok(Record {
        source,
        coordinate_system: CoordinateSystem::SourcePixelCenters,
        input: request,
        calibration,
        values,
    })
}

fn check_points(dimensions: [u32; 2], points: &[PixelPoint]) -> Result<()> {
    let max = dimensions.map(|n| f64::from(n) - 0.5);
    if points
        .iter()
        .any(|p| !(-0.5..=max[0]).contains(&p.x) || !(-0.5..=max[1]).contains(&p.y))
    {
        return Err(Error::InvalidRequest("landmark outside source frame"));
    }
    Ok(())
}

pub fn distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

pub fn angle(a: [f64; 2], vertex: [f64; 2], b: [f64; 2]) -> Result<f64> {
    let u = [a[0] - vertex[0], a[1] - vertex[1]];
    let v = [b[0] - vertex[0], b[1] - vertex[1]];
    if u[0].hypot(u[1]) <= f64::EPSILON || v[0].hypot(v[1]) <= f64::EPSILON {
        return Err(Error::Geometry("coincident angle landmarks"));
    }
    Ok((u[0] * v[1] - u[1] * v[0])
        .abs()
        .atan2(u[0] * v[0] + u[1] * v[1])
        .to_degrees())
}

pub struct Length;
pub struct Angle;

impl Method for Length {
    fn info(&self) -> MethodInfo {
        MethodInfo {
            id: "raykit:length",
            version: 1,
            name: "Length",
            landmarks: &["Start", "End"],
        }
    }

    fn evaluate(
        &self,
        context: &Context<'_>,
        parameters: &Value,
    ) -> Result<(Metric, Vec<Quantity>)> {
        let [a, b] = context.points else {
            return Err(Error::InvalidRequest("length landmarks"));
        };
        let metric = context.metric();
        if !parameters.is_null() && parameters != &serde_json::json!({"require_mm": true}) {
            return Err(Error::InvalidRequest("length parameters"));
        }
        if !parameters.is_null() && metric == Metric::Pixel {
            return Err(Error::Geometry(
                "no verified length calibration at these landmarks",
            ));
        }
        let unit = if metric == Metric::Pixel {
            Unit::Pixel
        } else {
            Unit::Millimeter
        };
        let value = distance(metric.coordinates(*a), metric.coordinates(*b));
        Ok((
            metric,
            vec![Quantity {
                name: "length".to_owned(),
                value,
                unit,
            }],
        ))
    }
}

impl Method for Angle {
    fn info(&self) -> MethodInfo {
        MethodInfo {
            id: "raykit:angle",
            version: 1,
            name: "Angle",
            landmarks: &["Arm 1", "Vertex", "Arm 2"],
        }
    }

    fn evaluate(
        &self,
        context: &Context<'_>,
        parameters: &Value,
    ) -> Result<(Metric, Vec<Quantity>)> {
        let [a, v, b] = context.points else {
            return Err(Error::InvalidRequest("angle landmarks"));
        };
        if !parameters.is_null() {
            return Err(Error::InvalidRequest("angle parameters"));
        }
        let metric = context.projection_metric();
        let value = angle(
            metric.coordinates(*a),
            metric.coordinates(*v),
            metric.coordinates(*b),
        )?;
        Ok((
            metric,
            vec![Quantity {
                name: "angle".to_owned(),
                value,
                unit: Unit::Degree,
            }],
        ))
    }
}
