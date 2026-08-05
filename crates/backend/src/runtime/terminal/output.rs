use std::collections::VecDeque;

use super::*;

#[derive(Debug, Clone)]
pub(crate) struct TerminalOutputChunk {
    pub(crate) start_offset: u64,
    pub(crate) data: Vec<u8>,
}

#[derive(Debug, Default)]
pub(crate) struct TerminalOutputBuffer {
    pub(crate) chunks: VecDeque<TerminalOutputChunk>,
    pub(crate) next_offset: u64,
}

impl TerminalOutputBuffer {
    pub(crate) fn append(&mut self, data: Vec<u8>) -> (u64, u64) {
        let start_offset = self.next_offset;
        self.next_offset = self.next_offset.saturating_add(data.len() as u64);
        self.chunks
            .push_back(TerminalOutputChunk { start_offset, data });
        while self.chunks.len() > MAX_RING_CHUNKS {
            self.chunks.pop_front();
        }
        (start_offset, self.next_offset)
    }
}

impl TerminalEchoDispatchState {
    pub(crate) fn dispatch(
        &mut self,
        payload: TerminalStreamEventPayload,
    ) -> TerminalOutputDispatch {
        let mut dispatch = TerminalOutputDispatch::default();
        for (index, byte) in payload.bytes.iter().copied().enumerate() {
            let offset = payload.start_offset.saturating_add(index as u64);
            if let Some(origin) = self.consume_echo_byte(byte) {
                match origin {
                    TerminalInputOrigin::Local => {
                        self.push_local_or_defer_remote(&mut dispatch, &payload, byte, offset);
                        if terminal_line_end(byte) {
                            self.flush_remote(&mut dispatch);
                        }
                    }
                    TerminalInputOrigin::Remote => {
                        self.push_remote_or_defer_local(&mut dispatch, &payload, byte, offset);
                        if terminal_line_end(byte) {
                            self.flush_local(&mut dispatch);
                        }
                    }
                }
            } else {
                self.push_visible_to_both(&mut dispatch, &payload, byte, offset);
            }
        }
        dispatch
    }

    pub(crate) fn consume_echo_byte(&mut self, byte: u8) -> Option<TerminalInputOrigin> {
        let front = self.pending.front().copied()?;
        if front.byte == byte || (byte == b'\n' && front.byte == b'\r') {
            self.pending.pop_front();
            return Some(front.origin);
        }
        if terminal_line_end(byte) {
            if let Some(index) = self
                .pending
                .iter()
                .position(|pending| terminal_line_end(pending.byte))
            {
                let origin = self
                    .pending
                    .get(index)
                    .map(|pending| pending.origin)
                    .unwrap_or(front.origin);
                for _ in 0..=index {
                    self.pending.pop_front();
                }
                return Some(origin);
            }
        }
        None
    }

    pub(crate) fn push_local_or_defer_remote(
        &mut self,
        dispatch: &mut TerminalOutputDispatch,
        template: &TerminalStreamEventPayload,
        byte: u8,
        offset: u64,
    ) {
        self.push_local(dispatch, template, byte, offset);
        push_payload_byte(&mut self.deferred_remote, template, byte, offset);
    }

    pub(crate) fn push_remote_or_defer_local(
        &mut self,
        dispatch: &mut TerminalOutputDispatch,
        template: &TerminalStreamEventPayload,
        byte: u8,
        offset: u64,
    ) {
        self.push_remote(dispatch, template, byte, offset);
        push_payload_byte(&mut self.deferred_local, template, byte, offset);
    }

    pub(crate) fn push_visible_to_both(
        &mut self,
        dispatch: &mut TerminalOutputDispatch,
        template: &TerminalStreamEventPayload,
        byte: u8,
        offset: u64,
    ) {
        self.push_local(dispatch, template, byte, offset);
        self.push_remote(dispatch, template, byte, offset);
    }

    pub(crate) fn push_local(
        &mut self,
        dispatch: &mut TerminalOutputDispatch,
        template: &TerminalStreamEventPayload,
        byte: u8,
        offset: u64,
    ) {
        if self.deferred_local.is_empty() {
            push_payload_byte(&mut dispatch.local, template, byte, offset);
        } else {
            push_payload_byte(&mut self.deferred_local, template, byte, offset);
        }
    }

    pub(crate) fn push_remote(
        &mut self,
        dispatch: &mut TerminalOutputDispatch,
        template: &TerminalStreamEventPayload,
        byte: u8,
        offset: u64,
    ) {
        if self.deferred_remote.is_empty() {
            push_payload_byte(&mut dispatch.remote, template, byte, offset);
        } else {
            push_payload_byte(&mut self.deferred_remote, template, byte, offset);
        }
    }

    pub(crate) fn flush_local(&mut self, dispatch: &mut TerminalOutputDispatch) {
        dispatch.local.append(&mut self.deferred_local);
    }

    pub(crate) fn flush_remote(&mut self, dispatch: &mut TerminalOutputDispatch) {
        dispatch.remote.append(&mut self.deferred_remote);
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.pending.is_empty() && self.deferred_local.is_empty() && self.deferred_remote.is_empty()
    }
}

pub(crate) fn push_payload_byte(
    payloads: &mut Vec<TerminalStreamEventPayload>,
    template: &TerminalStreamEventPayload,
    byte: u8,
    offset: u64,
) {
    let end_offset = offset.saturating_add(1);
    if let Some(last) = payloads.last_mut() {
        if last.end_offset == offset
            && last.session_id == template.session_id
            && last.project_path_key == template.project_path_key
        {
            last.bytes.push(byte);
            last.end_offset = end_offset;
            return;
        }
    }
    payloads.push(TerminalStreamEventPayload {
        kind: template.kind.clone(),
        session_id: template.session_id.clone(),
        project_path_key: template.project_path_key.clone(),
        start_offset: offset,
        end_offset,
        bytes: vec![byte],
    });
}

pub(crate) fn terminal_input_echo_candidates(
    data: &[u8],
    origin: TerminalInputOrigin,
) -> Vec<PendingEchoByte> {
    let mut bytes = Vec::new();
    let mut escape = TerminalEscapeParseState::None;
    for byte in data.iter().copied() {
        match escape {
            TerminalEscapeParseState::None => {
                if byte == 0x1b {
                    escape = TerminalEscapeParseState::Esc;
                } else if terminal_input_echo_candidate(byte) {
                    bytes.push(PendingEchoByte { byte, origin });
                }
            }
            TerminalEscapeParseState::Esc => {
                escape = if byte == b'[' {
                    TerminalEscapeParseState::Csi
                } else {
                    TerminalEscapeParseState::None
                };
            }
            TerminalEscapeParseState::Csi => {
                if (0x40..=0x7e).contains(&byte) {
                    escape = TerminalEscapeParseState::None;
                }
            }
        }
    }
    bytes
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalEscapeParseState {
    None,
    Esc,
    Csi,
}

pub(crate) fn terminal_input_echo_candidate(byte: u8) -> bool {
    byte == b'\r' || byte == b'\n' || byte == b'\t' || (byte >= 0x20 && byte != 0x7f)
}

pub(crate) fn terminal_line_end(byte: u8) -> bool {
    byte == b'\r' || byte == b'\n'
}

#[derive(Debug, Clone)]
pub(crate) struct TerminalOutputTail {
    pub(crate) output: Vec<u8>,
    pub(crate) truncated: bool,
    pub(crate) output_start_offset: u64,
    pub(crate) output_end_offset: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminalInputOrigin {
    Local,
    Remote,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct PendingEchoByte {
    pub(crate) byte: u8,
    pub(crate) origin: TerminalInputOrigin,
}

#[derive(Debug, Default)]
pub(crate) struct TerminalEchoDispatchState {
    pub(crate) pending: VecDeque<PendingEchoByte>,
    pub(crate) deferred_local: Vec<TerminalStreamEventPayload>,
    pub(crate) deferred_remote: Vec<TerminalStreamEventPayload>,
}

pub(crate) fn read_output_tail(
    entry: &TerminalSessionEntry,
    max_bytes: usize,
) -> TerminalOutputTail {
    let output = match entry.output.lock() {
        Ok(output) => output,
        Err(_) => {
            return TerminalOutputTail {
                output: Vec::new(),
                truncated: false,
                output_start_offset: 0,
                output_end_offset: 0,
            }
        }
    };
    read_output_chunks_tail(&output, max_bytes)
}

pub(crate) fn read_output_chunks_tail(
    output: &TerminalOutputBuffer,
    max_bytes: usize,
) -> TerminalOutputTail {
    let output_end_offset = output.next_offset;
    if max_bytes == 0 {
        return TerminalOutputTail {
            output: Vec::new(),
            truncated: output_end_offset > 0,
            output_start_offset: output_end_offset,
            output_end_offset,
        };
    }
    let mut remaining = max_bytes;
    let mut chunks = VecDeque::new();
    let mut truncated = false;
    for chunk in output.chunks.iter().rev() {
        if remaining == 0 {
            truncated = true;
            break;
        }
        let len = chunk.data.len();
        if len > remaining {
            let start = len.saturating_sub(remaining);
            chunks.push_front(TerminalOutputChunk {
                start_offset: chunk.start_offset.saturating_add(start as u64),
                data: chunk.data[start..].to_vec(),
            });
            truncated = true;
            break;
        }
        remaining = remaining.saturating_sub(len);
        chunks.push_front(chunk.clone());
    }
    let output_start_offset = chunks
        .front()
        .map(|chunk| chunk.start_offset)
        .unwrap_or(output_end_offset);
    let mut output_bytes = Vec::new();
    for chunk in chunks {
        output_bytes.extend_from_slice(&chunk.data);
    }
    TerminalOutputTail {
        output: output_bytes,
        truncated: truncated || output_start_offset > 0,
        output_start_offset,
        output_end_offset,
    }
}
