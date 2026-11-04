use std::sync::OnceLock;

/// Request identifiers for chat-run notifications carry the conversation id.
const CHAT_NOTIFICATION_ID_PREFIX: &str = "chat-run:";

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Keeps a handle so the notification delegate can route clicks back to the app.
pub fn install(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

pub fn chat_notification_id(conversation_id: &str) -> String {
    format!(
        "{CHAT_NOTIFICATION_ID_PREFIX}{conversation_id}:{}",
        uuid::Uuid::new_v4()
    )
}

/// Extracts the conversation id from a chat-run notification identifier.
pub fn conversation_id_from_notification_id(id: &str) -> Option<&str> {
    let rest = id.strip_prefix(CHAT_NOTIFICATION_ID_PREFIX)?;
    let (conversation_id, _nonce) = rest.rsplit_once(':')?;
    (!conversation_id.is_empty()).then_some(conversation_id)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn activate_from_notification(id: &str) {
    let Some(app) = APP.get() else { return };
    let Some(conversation_id) = conversation_id_from_notification_id(id) else {
        return;
    };
    use tauri::Emitter;
    let _ = crate::show_main_window(app);
    // Same action the tray menu uses to open a conversation.
    let _ = app.emit(
        "app:action",
        serde_json::json!({ "action": "open-conversation", "id": conversation_id }),
    );
}

pub fn disabled() -> bool {
    std::env::var("LIVEAGENT_DISABLE_NOTIFICATIONS").as_deref() == Ok("1")
}

pub async fn deliver(
    app: &tauri::AppHandle,
    id: String,
    title: String,
    body: String,
    request_permission: bool,
) -> Result<(), String> {
    if disabled() {
        return Err("Notifications are disabled for this process".into());
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || {
            mac::deliver(&id, &title, &body, request_permission)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = (id, request_permission);
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::{DynBlock, RcBlock};
    use objc2::{define_class, msg_send, rc::Retained, runtime::ProtocolObject, ClassType};
    use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::*;
    use std::{
        sync::{mpsc, Once},
        time::Duration,
    };

    define_class!(
        #[unsafe(super = NSObject)]
        struct PlanningNotificationDelegate;
        unsafe impl NSObjectProtocol for PlanningNotificationDelegate {}
        unsafe impl UNUserNotificationCenterDelegate for PlanningNotificationDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &DynBlock<dyn Fn()>,
            ) {
                let id = response.notification().request().identifier().to_string();
                super::activate_from_notification(&id);
                completion.call(());
            }
        }
    );

    fn wait<T>(receiver: mpsc::Receiver<T>) -> Result<T, String> {
        receiver
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "Notification service timed out".into())
    }

    pub fn deliver(
        id: &str,
        title: &str,
        body: &str,
        request_permission: bool,
    ) -> Result<(), String> {
        // UNUserNotificationCenter requires an actual app bundle, including in development.
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            return Err("Run LiveAgent from its .app bundle to enable macOS notifications".into());
        }
        let center = UNUserNotificationCenter::currentNotificationCenter();
        static DELEGATE: Once = Once::new();
        DELEGATE.call_once(|| {
            let delegate: Retained<PlanningNotificationDelegate> =
                unsafe { msg_send![PlanningNotificationDelegate::class(), new] };
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            // The center holds a weak delegate; retain this singleton for the process lifetime.
            let _ = Retained::into_raw(delegate);
        });
        if request_permission {
            let (tx, rx) = mpsc::channel();
            let callback =
                RcBlock::new(move |granted: objc2::runtime::Bool, error: *mut NSError| {
                    let result = if !error.is_null() {
                        Err(unsafe { &*error }.localizedDescription().to_string())
                    } else if !granted.as_bool() {
                        Err("Enable LiveAgent notifications in macOS System Settings".into())
                    } else {
                        Ok(())
                    };
                    let _ = tx.send(result);
                });
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &callback,
            );
            wait(rx)??;
        }
        let (tx, rx) = mpsc::channel();
        let callback = RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
            let settings = unsafe { settings.as_ref() };
            let allowed = settings.authorizationStatus() == UNAuthorizationStatus::Authorized
                && settings.alertSetting() == UNNotificationSetting::Enabled;
            let _ = tx.send(allowed);
        });
        center.getNotificationSettingsWithCompletionHandler(&callback);
        if !wait(rx)? {
            return Err("Enable LiveAgent notification alerts in macOS System Settings".into());
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(id),
            &content,
            None,
        );
        let (tx, rx) = mpsc::channel();
        let callback = RcBlock::new(move |error: *mut NSError| {
            let result = if error.is_null() {
                Ok(())
            } else {
                Err(unsafe { &*error }.localizedDescription().to_string())
            };
            let _ = tx.send(result);
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&callback));
        wait(rx)?
    }
}
