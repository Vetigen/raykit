use raykit_core::{
    Error, Object, Result,
    geometry::{Metric, PixelPoint},
    measurement::{Angle, Context, Length, Method, MethodInfo, Quantity, Unit, angle, distance},
};
use serde::Deserialize;
use serde_json::Value;

pub struct VertebralHeartSize;
pub struct NorbergAngle;
pub struct Tplo;

static METHODS: [&(dyn Method + Sync); 5] =
    [&Length, &Angle, &VertebralHeartSize, &NorbergAngle, &Tplo];

pub fn methods() -> impl Iterator<Item = MethodInfo> {
    METHODS.iter().map(|method| method.info())
}

pub fn method(id: &str) -> Result<&'static dyn Method> {
    METHODS
        .iter()
        .copied()
        .find(|method| method.info().id == id)
        .map(|method| method as &dyn Method)
        .ok_or(Error::Unsupported("measurement method"))
}

fn quantity(name: &str, value: f64, unit: Unit) -> Quantity {
    Quantity {
        name: name.to_owned(),
        value,
        unit,
    }
}

fn projection(context: &Context<'_>, value: &Value, view: &'static str) -> Result<Metric> {
    if context.object != Object::Projection
        || value.get("projection").and_then(Value::as_str) != Some(view)
    {
        return Err(Error::Geometry(
            "confirm the required radiographic projection",
        ));
    }
    Ok(context.projection_metric())
}

impl Method for VertebralHeartSize {
    fn info(&self) -> MethodInfo {
        MethodInfo {
            id: "raykit:canine-vhs",
            version: 1,
            name: "Vertebral heart size",
            landmarks: &[
                "Long axis base",
                "Long axis apex",
                "Short axis start",
                "Short axis end",
                "Cranial T4",
                "Cranial T5 and following cranial vertebral margins",
            ],
        }
    }

    fn evaluate(
        &self,
        context: &Context<'_>,
        parameters: &Value,
    ) -> Result<(Metric, Vec<Quantity>)> {
        let metric = projection(context, parameters, "lateral_thorax")?;
        let [a, b, c, d, spine @ ..] = context.points else {
            return Err(Error::InvalidRequest("VHS landmarks"));
        };
        if !(2..=16).contains(&spine.len()) {
            return Err(Error::InvalidRequest("VHS vertebral landmarks"));
        }
        let at = |p| metric.coordinates(p);
        let long = distance(at(*a), at(*b));
        let short = distance(at(*c), at(*d));
        if long <= 0.0 || short <= 0.0 {
            return Err(Error::Geometry("coincident cardiac axis landmarks"));
        }
        let lengths: Vec<_> = spine
            .windows(2)
            .map(|pair| distance(at(pair[0]), at(pair[1])))
            .collect();
        if lengths.contains(&0.0) {
            return Err(Error::Geometry("coincident vertebral landmarks"));
        }
        let scaled = |mut length: f64| {
            for (i, &segment) in lengths.iter().enumerate() {
                if length <= segment {
                    return Ok(((i as f64 + length / segment) * 10.0).round() / 10.0);
                }
                length -= segment;
            }
            Err(Error::Geometry("mark additional vertebral margins for VHS"))
        };
        let long = scaled(long)?;
        let short = scaled(short)?;
        Ok((
            metric,
            vec![
                quantity("long_axis", long, Unit::Vertebra),
                quantity("short_axis", short, Unit::Vertebra),
                quantity(
                    "vhs",
                    (long * 10.0 + short * 10.0).round() / 10.0,
                    Unit::Vertebra,
                ),
            ],
        ))
    }
}

impl Method for NorbergAngle {
    fn info(&self) -> MethodInfo {
        MethodInfo {
            id: "raykit:norberg",
            version: 1,
            name: "Norberg angles",
            landmarks: &[
                "Left femoral head center",
                "Right femoral head center",
                "Left cranial effective rim",
                "Right cranial effective rim",
            ],
        }
    }

    fn evaluate(
        &self,
        context: &Context<'_>,
        parameters: &Value,
    ) -> Result<(Metric, Vec<Quantity>)> {
        let metric = projection(context, parameters, "ventrodorsal_extended_hips")?;
        let [left, right, left_rim, right_rim] = context.points else {
            return Err(Error::InvalidRequest("Norberg landmarks"));
        };
        let at = |p: &PixelPoint| metric.coordinates(*p);
        let l = angle(at(right), at(left), at(left_rim))?;
        let r = angle(at(left), at(right), at(right_rim))?;
        Ok((
            metric,
            vec![
                quantity("left", l, Unit::Degree),
                quantity("right", r, Unit::Degree),
            ],
        ))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TploOptions {
    projection: String,
    target_deg: f64,
    radius_mm: f64,
}

impl Method for Tplo {
    fn info(&self) -> MethodInfo {
        MethodInfo {
            id: "raykit:tplo",
            version: 1,
            name: "TPLO geometry",
            landmarks: &[
                "Cranial medial plateau",
                "Caudal medial plateau",
                "Proximal mechanical axis",
                "Distal mechanical axis",
                "Osteotomy center",
            ],
        }
    }

    fn evaluate(
        &self,
        context: &Context<'_>,
        parameters: &Value,
    ) -> Result<(Metric, Vec<Quantity>)> {
        let metric = projection(context, parameters, "mediolateral_stifle")?;
        if !matches!(metric, Metric::Projection { .. }) {
            return Err(Error::Geometry(
                "TPLO requires patient-plane millimeter calibration",
            ));
        }
        let options: TploOptions = serde_json::from_value(parameters.clone())
            .map_err(|_| Error::InvalidRequest("TPLO target angle and radius"))?;
        if options.projection != "mediolateral_stifle"
            || !(-89.0..=89.0).contains(&options.target_deg)
            || !options.radius_mm.is_finite()
            || options.radius_mm <= 0.0
        {
            return Err(Error::InvalidRequest("TPLO target angle and radius"));
        }
        let [a, b, p, q, _center] = context.points else {
            return Err(Error::InvalidRequest("TPLO landmarks"));
        };
        let at = |point: &PixelPoint| metric.coordinates(*point);
        let [a, b, p, q] = [a, b, p, q].map(at);
        let axis = [p[0] - q[0], p[1] - q[1]];
        let plateau = [b[0] - a[0], b[1] - a[1]];
        let perpendicular = [-axis[1], axis[0]];
        let along = plateau[0] * perpendicular[0] + plateau[1] * perpendicular[1];
        if axis[0].hypot(axis[1]) <= f64::EPSILON
            || plateau[0].hypot(plateau[1]) <= f64::EPSILON
            || along.abs() <= f64::EPSILON
        {
            return Err(Error::Geometry("degenerate TPLO axes"));
        }
        let down = -(plateau[0] * axis[0] + plateau[1] * axis[1]);
        let tpa = down.atan2(along.abs()).to_degrees();
        let rotation = tpa - options.target_deg;
        if rotation.abs() >= 90.0 {
            return Err(Error::Geometry("TPLO rotation outside tool geometry"));
        }
        let chord = 2.0 * options.radius_mm * (0.5 * rotation.abs().to_radians()).sin();
        Ok((
            metric,
            vec![
                quantity("plateau_angle", tpa, Unit::Degree),
                quantity("rotation", rotation, Unit::Degree),
                quantity("chord", chord, Unit::Millimeter),
                quantity("radius", options.radius_mm, Unit::Millimeter),
            ],
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use raykit_core::{
        FrameGeometry,
        geometry::{Anatomy, Calibration, ProjectionCalibration},
    };

    fn geometry() -> FrameGeometry {
        FrameGeometry {
            calibration: Calibration::Projection {
                spacing_xy: [0.5, 0.25],
                method: ProjectionCalibration::Fiducial,
            },
            detector_spacing_xy: Some([0.4, 0.4]),
            display_spacing_xy: [0.5, 0.25],
            patient_plane: None,
            anatomy: Anatomy::Unknown,
            increasing_column: None,
            increasing_row: None,
        }
    }

    #[test]
    fn norberg_and_tplo_match_analytic_geometry() {
        let geometry = geometry();
        let points = [(10.0, 10.0), (20.0, 10.0), (10.0, 20.0), (20.0, 20.0)]
            .map(|(x, y)| PixelPoint { x, y });
        let context = Context {
            object: Object::Projection,
            geometry: &geometry,
            points: &points,
        };
        let (_, results) = NorbergAngle
            .evaluate(
                &context,
                &serde_json::json!({"projection":"ventrodorsal_extended_hips"}),
            )
            .unwrap();
        assert_eq!(
            results.iter().map(|q| q.value).collect::<Vec<_>>(),
            [90.0, 90.0]
        );
        let points = [
            (10.0, 10.0),
            (20.0, 20.0),
            (15.0, 8.0),
            (15.0, 38.0),
            (15.0, 15.0),
        ]
        .map(|(x, y)| PixelPoint { x, y });
        let context = Context {
            points: &points,
            ..context
        };
        let params = serde_json::json!({"projection":"mediolateral_stifle", "target_deg":12, "radius_mm":10});
        let (_, results) = Tplo.evaluate(&context, &params).unwrap();
        let measured = 0.5_f64.atan().to_degrees();
        let rotation = measured - 12.0;
        assert!((results[0].value - measured).abs() < 1e-12);
        assert!((results[2].value - 20.0 * (rotation.to_radians() / 2.0).sin()).abs() < 1e-12);
        let uncalibrated = FrameGeometry {
            calibration: Calibration::None,
            ..geometry.clone()
        };
        let context = Context {
            geometry: &uncalibrated,
            ..context
        };
        assert!(matches!(
            Tplo.evaluate(&context, &params),
            Err(Error::Geometry(_))
        ));
    }
}
