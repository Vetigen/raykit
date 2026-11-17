use raykit_protocol::{BoundSession, OpenOptions, Reply, error_json};
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
