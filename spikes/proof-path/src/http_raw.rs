//! Minimal HTTP/1.1 parsing over the *raw* revealed transcript bytes.
//! Deliberately independent of tlsn-formats so that a malformed body (truncated JSON,
//! wrong Content-Length) still yields a status line and headers for the predicate.

use anyhow::{Context, Result, bail};

#[derive(Debug, Clone)]
pub struct RawRequest {
    pub method: String,
    pub target: String,
    /// header names lower-cased
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct RawResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// Body bytes as received (may be shorter than Content-Length if the server cut it off).
    pub body: Vec<u8>,
}

pub fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    let n = name.to_ascii_lowercase();
    headers.iter().find(|(k, _)| *k == n).map(|(_, v)| v.as_str())
}

pub fn parse_request(bytes: &[u8]) -> Result<RawRequest> {
    let mut hdrs = [httparse::EMPTY_HEADER; 64];
    let mut req = httparse::Request::new(&mut hdrs);
    let status = req.parse(bytes).context("request head does not parse")?;
    let head_len = match status {
        httparse::Status::Complete(n) => n,
        httparse::Status::Partial => bail!("request head incomplete"),
    };
    let headers = req
        .headers
        .iter()
        .map(|h| (h.name.to_ascii_lowercase(), String::from_utf8_lossy(h.value).to_string()))
        .collect::<Vec<_>>();
    Ok(RawRequest {
        method: req.method.context("no method")?.to_string(),
        target: req.path.context("no target")?.to_string(),
        headers,
        body: bytes[head_len..].to_vec(),
    })
}

pub fn parse_response(bytes: &[u8]) -> Result<RawResponse> {
    let mut hdrs = [httparse::EMPTY_HEADER; 64];
    let mut res = httparse::Response::new(&mut hdrs);
    let status = res.parse(bytes).context("response head does not parse")?;
    let head_len = match status {
        httparse::Status::Complete(n) => n,
        httparse::Status::Partial => bail!("response head incomplete"),
    };
    let headers = res
        .headers
        .iter()
        .map(|h| (h.name.to_ascii_lowercase(), String::from_utf8_lossy(h.value).to_string()))
        .collect::<Vec<_>>();
    Ok(RawResponse {
        status: res.code.context("no status code")?,
        headers,
        body: bytes[head_len..].to_vec(),
    })
}
