use serde::{Deserialize, Serialize};

use crate::{Error, Result};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct PixelPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct PatientPoint(pub [f64; 3]);

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct PatientPlane {
    pub origin: PatientPoint,
    pub column_axis: [f64; 3],
    pub row_axis: [f64; 3],
    pub spacing_xy: [f64; 2],
}

impl PatientPlane {
    pub(crate) fn new(origin: [f64; 3], axes: [f64; 6], spacing: [f64; 2]) -> Option<Self> {
        let column: [f64; 3] = axes[..3].try_into().ok()?;
        let row: [f64; 3] = axes[3..].try_into().ok()?;
        let col_len = dot(column, column).sqrt();
        let row_len = dot(row, row).sqrt();
        if !origin.iter().all(|n| n.is_finite())
            || (col_len - 1.0).abs() > 0.001
            || (row_len - 1.0).abs() > 0.001
            || dot(column, row).abs() > 0.001
            || !valid_spacing(spacing)
        {
            return None;
        }
        let column_axis = scale(column, 1.0 / col_len);
        let row = sub(row, scale(column_axis, dot(row, column_axis)));
        let row_axis = scale(row, 1.0 / dot(row, row).sqrt());
        Some(Self {
            origin: PatientPoint(origin),
            column_axis,
            row_axis,
            spacing_xy: spacing,
        })
    }

    pub fn at(self, p: PixelPoint) -> PatientPoint {
        PatientPoint(add(
            self.origin.0,
            add(
                scale(self.column_axis, p.x * self.spacing_xy[0]),
                scale(self.row_axis, p.y * self.spacing_xy[1]),
            ),
        ))
    }

    pub fn project(self, p: PatientPoint) -> (PixelPoint, f64) {
        let delta = sub(p.0, self.origin.0);
        (
            PixelPoint {
                x: dot(self.column_axis, delta) / self.spacing_xy[0],
                y: dot(self.row_axis, delta) / self.spacing_xy[1],
            },
            dot(self.normal(), delta),
        )
    }

    pub fn normal(self) -> [f64; 3] {
        cross(self.column_axis, self.row_axis)
    }
}

pub(crate) fn valid_spacing(spacing: [f64; 2]) -> bool {
    spacing.iter().all(|n| (1e-9..=1e9).contains(n))
}

pub(crate) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| a[i] - b[i])
}

pub(crate) fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| a[i] + b[i])
}

pub(crate) fn scale(a: [f64; 3], b: f64) -> [f64; 3] {
    a.map(|n| n * b)
}

pub(crate) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Region {
    Head,
    Trunk,
    ProximalLimb,
    DistalForelimb,
    DistalHindlimb,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Anatomy {
    Biped,
    Quadruped(Region),
    Unknown,
}

impl Anatomy {
    /// Directions in order of decreasing contribution to the given axis.
    pub fn direction(self, vector: [f64; 3]) -> Option<Vec<&'static str>> {
        let (y, z) = match self {
            Self::Biped => (["anterior", "posterior"], ["inferior", "superior"]),
            Self::Quadruped(region) => match region {
                Region::Head => (["ventral", "dorsal"], ["caudal", "rostral"]),
                Region::Trunk => (["ventral", "dorsal"], ["caudal", "cranial"]),
                Region::ProximalLimb => (["caudal", "cranial"], ["distal", "proximal"]),
                Region::DistalForelimb => (["palmar", "dorsal"], ["distal", "proximal"]),
                Region::DistalHindlimb => (["plantar", "dorsal"], ["distal", "proximal"]),
                Region::Unknown => return None,
            },
            Self::Unknown => return None,
        };
        let directions = [["right", "left"], y, z];
        let mut order = [0, 1, 2];
        order.sort_by(|&a, &b| vector[b].abs().total_cmp(&vector[a].abs()));
        Some(
            order
                .into_iter()
                .filter(|&index| vector[index].abs() > 0.0001)
                .map(|index| directions[index][usize::from(vector[index] > 0.0)])
                .collect(),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Calibration {
    None,
    PatientPlane {
        spacing_xy: [f64; 2],
    },
    Projection {
        spacing_xy: [f64; 2],
        method: ProjectionCalibration,
    },
    Ultrasound {
        regions: Vec<UltrasoundRegion>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionCalibration {
    Fiducial,
    Geometry,
    CorrectedSpacing,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UltrasoundRegion {
    pub bounds: [u32; 4],
    pub delta_xy: [f64; 2],
    pub units_xy: [u16; 2],
    pub spatial_format: u16,
}

impl UltrasoundRegion {
    fn contains(&self, p: PixelPoint) -> bool {
        let [l, t, r, b] = self.bounds.map(f64::from);
        p.x >= l && p.x <= r && p.y >= t && p.y <= b
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Metric {
    Pixel,
    DetectorAspect {
        ratio_yx: f64,
    },
    PatientPlane {
        spacing_xy: [f64; 2],
    },
    Projection {
        spacing_xy: [f64; 2],
        method: ProjectionCalibration,
    },
    UltrasoundRegion {
        index: usize,
        spacing_xy: [f64; 2],
    },
}

impl Calibration {
    pub fn metric(&self, points: &[PixelPoint]) -> Option<Metric> {
        match self {
            Self::None => None,
            Self::PatientPlane { spacing_xy } => Some(Metric::PatientPlane {
                spacing_xy: *spacing_xy,
            }),
            Self::Projection { spacing_xy, method } => Some(Metric::Projection {
                spacing_xy: *spacing_xy,
                method: *method,
            }),
            Self::Ultrasound { regions } => {
                let mut containing = regions
                    .iter()
                    .enumerate()
                    .filter(|(_, r)| points.iter().any(|p| r.contains(*p)));
                let (index, r) = containing.next()?;
                if containing.next().is_some()
                    || !points.iter().all(|p| r.contains(*p))
                    || r.units_xy != [3, 3]
                    || r.spatial_format != 1
                {
                    return None;
                }
                let spacing_xy = r.delta_xy.map(|v| v * 10.0);
                spacing_xy
                    .iter()
                    .all(|n| n.is_finite() && *n != 0.0)
                    .then_some(Metric::UltrasoundRegion { index, spacing_xy })
            }
        }
    }
}

impl Metric {
    pub fn scale(self) -> [f64; 2] {
        match self {
            Self::Pixel => [1.0, 1.0],
            Self::DetectorAspect { ratio_yx } => [1.0, ratio_yx],
            Self::PatientPlane { spacing_xy }
            | Self::Projection { spacing_xy, .. }
            | Self::UltrasoundRegion { spacing_xy, .. } => spacing_xy,
        }
    }

    pub fn coordinates(self, p: PixelPoint) -> [f64; 2] {
        let [x, y] = self.scale();
        [p.x * x, p.y * y]
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct View {
    pub viewport: [f64; 2],
    pub pan: [f64; 2],
    pub zoom: f64,
    pub quarter_turns: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct ViewTransform {
    pub origin: ScreenPoint,
    pub x_axis: [f64; 2],
    pub y_axis: [f64; 2],
}

impl View {
    pub fn transform(self, columns: u32, rows: u32, spacing_xy: [f64; 2]) -> Result<ViewTransform> {
        if columns == 0
            || rows == 0
            || !valid_spacing(spacing_xy)
            || !valid_spacing(self.viewport)
            || !self.pan.iter().all(|n| n.is_finite())
            || !(0.01..=128.0).contains(&self.zoom)
        {
            return Err(Error::InvalidRequest("view transform"));
        }
        let aspect = spacing_xy[1] / spacing_xy[0];
        let mut extent = [f64::from(columns), f64::from(rows) * aspect];
        let turn = self.quarter_turns % 4;
        if turn % 2 == 1 {
            extent.swap(0, 1);
        }
        let sx = (self.viewport[0] / extent[0]).min(self.viewport[1] / extent[1]) * self.zoom;
        let sy = sx * aspect;
        let (x_axis, y_axis) = match turn {
            0 => ([sx, 0.0], [0.0, sy]),
            1 => ([0.0, sx], [-sy, 0.0]),
            2 => ([-sx, 0.0], [0.0, -sy]),
            _ => ([0.0, -sx], [sy, 0.0]),
        };
        let mx = (f64::from(columns) - 1.0) / 2.0;
        let my = (f64::from(rows) - 1.0) / 2.0;
        Ok(ViewTransform {
            origin: ScreenPoint {
                x: self.viewport[0] / 2.0 + self.pan[0] - mx * x_axis[0] - my * y_axis[0],
                y: self.viewport[1] / 2.0 + self.pan[1] - mx * x_axis[1] - my * y_axis[1],
            },
            x_axis,
            y_axis,
        })
    }
}

impl ViewTransform {
    pub fn to_screen(self, p: PixelPoint) -> ScreenPoint {
        ScreenPoint {
            x: self.origin.x + p.x * self.x_axis[0] + p.y * self.y_axis[0],
            y: self.origin.y + p.x * self.x_axis[1] + p.y * self.y_axis[1],
        }
    }

    pub fn to_pixel(self, p: ScreenPoint) -> PixelPoint {
        let [x, y] = [p.x - self.origin.x, p.y - self.origin.y];
        let [a, b] = self.x_axis;
        let [c, d] = self.y_axis;
        let det = a * d - b * c;
        PixelPoint {
            x: (d * x - c * y) / det,
            y: (a * y - b * x) / det,
        }
    }
}
