use raykit_core::{
    Error, Limits, Result, Session,
    geometry::{Metric, PixelPoint},
    measurement::{Context, Method, MethodInfo, Quantity, Request, Unit, distance},
};

struct LandmarkRatio;

impl Method for LandmarkRatio {
    fn info(&self) -> MethodInfo {
        MethodInfo {
            id: "example:landmark-ratio",
            version: 1,
            name: "Landmark ratio",
            landmarks: &[
                "Numerator start",
                "Numerator end",
                "Denominator start",
                "Denominator end",
            ],
        }
    }

    fn evaluate(
        &self,
        context: &Context<'_>,
        parameters: &serde_json::Value,
    ) -> Result<(Metric, Vec<Quantity>)> {
        if !parameters.is_null() {
            return Err(Error::InvalidRequest("landmark ratio has no parameters"));
        }
        let [a, b, c, d] = context.points else {
            return Err(Error::InvalidRequest("four landmarks are required"));
        };
        let metric = context.projection_metric();
        let at = |p: &PixelPoint| metric.coordinates(*p);
        let reference = distance(at(c), at(d));
        if reference == 0.0 {
            return Err(Error::Geometry("reference landmarks coincide"));
        }
        Ok((
            metric,
            vec![Quantity {
                name: "landmark_ratio".into(),
                value: distance(at(a), at(b)) / reference,
                unit: Unit::Ratio,
            }],
        ))
    }
}

fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "fixtures/generated/signed12.dcm".into());
    let input = std::fs::read(path)?;
    let mut writer = Session::open(input.clone(), Limits::default())?;
    let points = [(2.0, 3.0), (8.0, 3.0), (2.0, 6.0), (6.0, 6.0)]
        .into_iter()
        .map(|(x, y)| PixelPoint { x, y })
        .collect();
    let request = Request {
        id: "synthetic-ratio".into(),
        method: LandmarkRatio.info().id.into(),
        version: 1,
        points,
        parameters: serde_json::Value::Null,
    };
    let record = writer.measure(0, request, &LandmarkRatio)?;
    let output = serde_json::to_vec_pretty(&record)?;
    let mut reader = Session::open(input, Limits::default())?;
    let actual = reader.reopen_measurement(serde_json::from_slice(&output)?, &LandmarkRatio)?;
    assert_eq!(actual, record);
    assert_eq!(actual.values[0].value, 1.5);
    println!("{}", String::from_utf8(output)?);
    Ok(())
}
