use crate::{
    Error, Result, TransferSyntax,
    pixel::{PixelFormat, Samples},
};

pub(super) fn decode_extended_jpeg(
    raw: &[u8],
    format: PixelFormat,
    syntax: TransferSyntax,
) -> Result<Samples> {
    let values = if syntax == TransferSyntax::JpegExtended {
        oxiarc_jpeg::Decoder::new(raw)
            .decode_u16()
            .map_err(|_| Error::Decode("12-bit JPEG samples"))?
    } else {
        let config = jpegls::DecodeImageOptions {
            max_decoded_bytes: format.pixels() * 2,
        };
        let decoded = jpegls::decode_image_with_options(raw, &config)
            .map_err(|_| Error::Decode("JPEG-LS samples"))?;
        if decoded.width != format.columns
            || decoded.height != format.rows
            || decoded.bits_per_sample != format.bits_stored
            || decoded.components != 1
            || syntax == TransferSyntax::JpegLsLossless && decoded.near != 0
        {
            return Err(Error::Decode("JPEG-LS output format"));
        }
        decoded.samples
    };
    if values.len() != format.pixels() {
        return Err(Error::Decode("extended JPEG output length"));
    }
    Ok(Samples::Monochrome(
        values
            .into_iter()
            .map(|value| format.stored(value, true))
            .collect(),
    ))
}

pub(super) fn decode_wavelet(
    raw: &[u8],
    format: PixelFormat,
    syntax: TransferSyntax,
) -> Result<Samples> {
    if format.pixels() > 4 * 1024 * 1024 {
        return Err(Error::Limit("wavelet frame pixels"));
    }
    let bytes = if raw.ends_with(&[0xff, 0xd9, 0]) {
        &raw[..raw.len() - 1]
    } else {
        raw
    };
    validate_wavelet(bytes, format, syntax)?;
    let mut decoder = openjp2::Decoder::new(openjp2::Format::J2k)
        .map_err(|_| Error::Decode("wavelet decoder initialization"))?;
    let image = decoder
        .decode_slice(bytes)
        .map_err(|_| Error::Decode("JPEG 2000 samples"))?;
    let [component] = image.components.as_slice() else {
        return Err(Error::Decode("wavelet output component count"));
    };
    if component.width != format.columns
        || component.height != format.rows
        || component.precision != format.bits_stored
        || component.signed != format.signed
        || component.data.len() != format.pixels()
    {
        return Err(Error::Decode("wavelet output format"));
    }
    let component = image.components.into_iter().next().ok_or(Error::Internal)?;
    Ok(Samples::Monochrome(component.data))
}

/// Validate the codestream before a decoder reserves coefficient and sample buffers.
fn validate_wavelet(raw: &[u8], format: PixelFormat, syntax: TransferSyntax) -> Result<()> {
    if raw.len() < 45
        || !raw.starts_with(&[0xff, 0x4f, 0xff, 0x51])
        || !raw.ends_with(&[0xff, 0xd9])
    {
        return Err(Error::Decode("wavelet codestream markers"));
    }
    let u16_at = |p: usize| u16::from_be_bytes([raw[p], raw[p + 1]]);
    let u32_at = |p| u32::from_be_bytes(raw[p..p + 4].try_into().expect("wavelet header word"));
    if u16_at(40) != 1
        || u16_at(4) != 41
        || u32_at(8) != format.columns
        || u32_at(12) != format.rows
        || raw[42] & 0x7f != format.bits_stored - 1
        || (raw[42] & 0x80 != 0) != format.signed
    {
        return Err(Error::InvalidDicom("wavelet SIZ differs from Pixel Module"));
    }
    if u32_at(16) != 0
        || u32_at(20) != 0
        || u32_at(32) != 0
        || u32_at(36) != 0
        || u32_at(24) != format.columns
        || u32_at(28) != format.rows
        || raw[43..45] != [1, 1]
    {
        return Err(Error::Unsupported("wavelet tile geometry"));
    }
    let mut position = 45;
    let mut cod = None;
    let mut tile_end = None;
    while position + 4 <= raw.len() {
        let at = position;
        let marker = u16_at(position);
        if marker == 0xff93 {
            if tile_end != Some(raw.len() - 2) {
                return Err(Error::Decode("wavelet tile part boundary"));
            }
            break;
        }
        if marker & 0xff00 != 0xff00 || marker == 0xffd9 {
            return Err(Error::Decode("wavelet marker sequence"));
        }
        let length = usize::from(u16_at(position + 2));
        if length < 2 || position + 2 + length > raw.len() {
            return Err(Error::Decode("wavelet marker length"));
        }
        position += length + 2;
        let segment = &raw[at + 4..position];
        match marker {
            0xff52 if cod.is_none() && tile_end.is_none() && segment.len() >= 10 => {
                cod = Some(segment);
            }
            0xff52 | 0xff53 | 0xff5f => {
                return Err(Error::Unsupported("wavelet coding style overrides"));
            }
            0xff90
                if tile_end.is_none()
                    && segment.len() == 8
                    && segment[..2] == [0, 0]
                    && segment[6] == 0
                    && segment[7] <= 1 =>
            {
                let length = u32_at(at + 6) as usize;
                tile_end = if length == 0 {
                    Some(raw.len() - 2)
                } else {
                    at.checked_add(length)
                };
            }
            0xff90 => return Err(Error::Unsupported("multiple wavelet tile parts")),
            _ => {}
        }
    }
    if tile_end.is_none() || raw.get(position..position + 2) != Some(&[0xff, 0x93]) {
        return Err(Error::Decode("wavelet start of data"));
    }
    let cod = cod.ok_or(Error::Decode("wavelet COD marker"))?;
    if cod[5] > 8
        || cod[6] > 8
        || cod[7] > 8
        || cod[4] != 0
        || u16::from_be_bytes([cod[2], cod[3]]) > 16
    {
        return Err(Error::Limit(
            "wavelet decomposition, code blocks or quality layers",
        ));
    }
    let ht = matches!(
        syntax,
        TransferSyntax::Htj2k | TransferSyntax::Htj2kLossless | TransferSyntax::Htj2kLosslessRpcl
    );
    if ht != (cod[8] & 0x40 != 0) || syntax == TransferSyntax::Htj2kLosslessRpcl && cod[1] != 2 {
        return Err(Error::InvalidDicom(
            "wavelet coding process differs from transfer syntax",
        ));
    }
    if matches!(
        syntax,
        TransferSyntax::Jpeg2000Lossless
            | TransferSyntax::Htj2kLossless
            | TransferSyntax::Htj2kLosslessRpcl
    ) && cod[9] != 1
    {
        return Err(Error::InvalidDicom(
            "irreversible codestream under lossless transfer syntax",
        ));
    }
    Ok(())
}
