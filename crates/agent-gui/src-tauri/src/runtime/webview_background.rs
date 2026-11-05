//! Keeps the main webview running at full speed while its window is covered.
//!
//! The K-brain event stream is a `fetch` body read inside the webview, so
//! `permission.requested` / `question.requested` only reach the app (the
//! attention notification, the AskUserQuestion answer window) once the
//! webview's processes get CPU time.
//!
//! WebKit treats a window that is fully covered by other windows, or
//! minimized, as hidden. A few seconds later it moves the WebContent,
//! Networking and GPU processes into the background CPU band (priority 4),
//! and `backgroundThrottling: "disabled"` (WKPreferences.inactiveSchedulingPolicy
//! = none) does not prevent that. On a busy machine those processes then fall
//! behind, and stream data reaches JavaScript seconds late.
//!
//! Turning WKWebView's window occlusion detection off makes a covered or
//! minimized window count as visible, which is what disabling background
//! throttling asks for. A window hidden to the tray is still hidden to WebKit.

use objc2::runtime::AnyObject;
use objc2::{msg_send, sel};

/// Turns off window occlusion detection on a `WKWebView`.
/// Returns false when this WebKit no longer has the (private) setter.
///
/// # Safety
/// `web_view` must point to a live `WKWebView`, used on the main thread.
unsafe fn disable_occlusion_detection(web_view: *mut AnyObject) -> bool {
    let setter = sel!(_setWindowOcclusionDetectionEnabled:);
    let supported: bool = msg_send![web_view, respondsToSelector: setter];
    if supported {
        let _: () = msg_send![web_view, _setWindowOcclusionDetectionEnabled: false];
    }
    supported
}

pub(crate) fn keep_webview_live_when_covered(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|webview| {
        let web_view = webview.inner().cast::<AnyObject>();
        if web_view.is_null() {
            return;
        }
        // SAFETY: `web_view` is the live WKWebView wry created for this window,
        // and this closure runs on the main thread.
        if !unsafe { disable_occlusion_detection(web_view) } {
            eprintln!("WebKit has no occlusion detection switch; a covered window's event delivery may lag");
        }
    });
    if let Err(error) = result {
        eprintln!("failed to keep the covered webview running: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::runtime::{AnyClass, Bool, ClassBuilder, NSObject, Sel};
    use objc2::ClassType;
    use std::sync::atomic::{AtomicI8, Ordering};

    static RECEIVED: AtomicI8 = AtomicI8::new(-1);

    extern "C-unwind" fn record(_this: &NSObject, _cmd: Sel, enabled: Bool) {
        RECEIVED.store(enabled.as_bool() as i8, Ordering::SeqCst);
    }

    #[test]
    fn shipped_webkit_still_has_the_occlusion_detection_switch() {
        // A WKWebView cannot be created outside an app bundle (WebKit traps
        // during initialization), so check the class itself.
        let class = AnyClass::get(c"WKWebView").expect("WebKit is linked");
        assert!(class
            .instance_method(sel!(_setWindowOcclusionDetectionEnabled:))
            .is_some());
        assert!(class
            .instance_method(sel!(_windowOcclusionDetectionEnabled))
            .is_some());
    }

    #[test]
    fn occlusion_detection_is_switched_off_when_the_setter_exists() {
        let mut builder = ClassBuilder::new(c"LiveAgentFakeWKWebView", NSObject::class())
            .expect("unique class name");
        unsafe {
            builder.add_method(
                sel!(_setWindowOcclusionDetectionEnabled:),
                record as extern "C-unwind" fn(_, _, _),
            );
        }
        let class = builder.register();
        unsafe {
            let web_view: *mut AnyObject = msg_send![class, new];
            assert!(disable_occlusion_detection(web_view));
            let _: () = msg_send![web_view, release];
        }
        assert_eq!(RECEIVED.load(Ordering::SeqCst), 0, "setter must receive NO");
    }

    #[test]
    fn missing_setter_is_reported_instead_of_sent() {
        unsafe {
            let object: *mut AnyObject = msg_send![NSObject::class(), new];
            assert!(!disable_occlusion_detection(object));
            let _: () = msg_send![object, release];
        }
    }
}
