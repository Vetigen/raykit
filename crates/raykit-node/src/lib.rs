use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use napi::{
    Env, Error, Result, Task,
    bindgen_prelude::{AsyncTask, Buffer},
};
use napi_derive::napi;
use raykit_protocol::{BoundSession, OpenOptions, Reply, error_json};

fn failure(error: raykit_core::Error) -> Error {
    Error::from_reason(error_json(&error))
}

type Session = Arc<Mutex<Option<BoundSession>>>;

#[napi]
pub struct NativeSession {
    session: Session,
    metadata: String,
}

#[napi]
impl NativeSession {
    #[napi(getter)]
    pub fn metadata(&self) -> String {
        self.metadata.clone()
    }

    #[napi]
    pub fn request(&self, command: String) -> AsyncTask<RequestTask> {
        AsyncTask::new(RequestTask {
            session: self.session.clone(),
            command: Some(command),
        })
    }

    #[napi]
    pub fn close(&self) -> AsyncTask<RequestTask> {
        AsyncTask::new(RequestTask {
            session: self.session.clone(),
            command: None,
        })
    }
}

pub struct OpenTask {
    path: String,
    options: String,
}

impl Task for OpenTask {
    type Output = (BoundSession, Reply);
    type JsValue = NativeSession;

    fn compute(&mut self) -> Result<Self::Output> {
        let settings = OpenOptions::parse(self.options.as_bytes()).map_err(failure)?;
        BoundSession::open_path(Path::new(&self.path), settings).map_err(failure)
    }

    fn resolve(&mut self, _: Env, (session, reply): Self::Output) -> Result<Self::JsValue> {
        Ok(NativeSession {
            session: Arc::new(Mutex::new(Some(session))),
            metadata: reply.metadata,
        })
    }
}

#[napi]
pub fn open_native(path: String, options: String) -> AsyncTask<OpenTask> {
    AsyncTask::new(OpenTask { path, options })
}

#[napi(object)]
pub struct NativeReply {
    pub metadata: String,
    pub bytes: Buffer,
}

pub struct RequestTask {
    session: Session,
    command: Option<String>,
}

impl Task for RequestTask {
    type Output = Reply;
    type JsValue = NativeReply;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut slot = self
            .session
            .lock()
            .map_err(|_| failure(raykit_core::Error::Internal))?;
        let Some(command) = &self.command else {
            slot.take();
            return Ok(Reply {
                metadata: "null".into(),
                data: Vec::new(),
            });
        };
        slot.as_mut()
            .ok_or_else(|| failure(raykit_core::Error::Closed))?
            .request(command.as_bytes())
            .map_err(failure)
    }

    fn resolve(&mut self, _: Env, reply: Reply) -> Result<Self::JsValue> {
        Ok(NativeReply {
            metadata: reply.metadata,
            bytes: Buffer::from(reply.data),
        })
    }
}
