//! macOS 系统通知：`UNUserNotificationCenter`。
//!
//! tauri-plugin-notification 在 macOS 上走已弃用的 `NSUserNotificationCenter`：从不请求授权，
//! 应用不会出现在「系统设置 → 通知」里，也读不到真实权限。这里改用系统现行接口：
//! - 首次发送时请求授权（之后 LiveAgent 出现在系统通知设置中，用户可在那里管理）；
//! - 读取真实权限，被拒绝时返回 `E:permission_denied` 而不是假装成功；
//! - 设置委托：应用在前台时也显示横幅，点击通知时回调（调出主窗口）。
//!
//! 只在从 .app 包运行时可用：`tauri dev` 的裸二进制没有 bundle，此时调用
//! `currentNotificationCenter` 会抛出异常，由调用方回退到插件。

use std::sync::{mpsc, OnceLock};
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};

/// 系统查询（权限状态、投递结果）的等待上限；回调来自系统的后台队列。
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
/// 授权弹窗需要用户操作，等待更久。
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    NotDetermined,
    Denied,
    Granted,
}

type ActivateHandler = Box<dyn Fn() + Send + Sync>;

pub struct DelegateIvars {
    on_activate: ActivateHandler,
}

define_class!(
    // SAFETY: NSObject 没有子类化要求；本类型不实现 Drop。
    #[unsafe(super(NSObject))]
    #[ivars = DelegateIvars]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        /// 默认情况下应用在前台时系统不显示横幅；这里要求照常显示并进入通知中心。
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        /// 点击通知：调出主窗口。
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            _response: &UNNotificationResponse,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            (self.ivars().on_activate)();
            completion_handler.call(());
        }
    }
);

// SAFETY: ivars 只有 `Send + Sync` 的回调；委托方法由系统在任意队列调用。
unsafe impl Send for NotificationDelegate {}
unsafe impl Sync for NotificationDelegate {}

impl NotificationDelegate {
    fn new(on_activate: ActivateHandler) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { on_activate });
        unsafe { msg_send![super(this), init] }
    }
}

/// 通知中心只持有委托的弱引用，这里保证它与进程同寿命。
static DELEGATE: OnceLock<Retained<NotificationDelegate>> = OnceLock::new();

/// 当前进程是否从 .app 包运行（有 bundle id）。
pub fn available() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

/// 安装委托（只生效一次）。应尽早调用，以便收到启动前的点击。
pub fn install(on_activate: ActivateHandler) {
    let delegate = DELEGATE.get_or_init(|| NotificationDelegate::new(on_activate));
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
}

pub fn permission() -> Result<Permission, String> {
    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        let _ = sender.send(status);
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&handler);
    let status = receiver
        .recv_timeout(QUERY_TIMEOUT)
        .map_err(|_| "E:unavailable:notification settings timed out".to_string())?;
    Ok(match status {
        UNAuthorizationStatus::NotDetermined => Permission::NotDetermined,
        UNAuthorizationStatus::Denied => Permission::Denied,
        // Authorized / Provisional / Ephemeral 都能投递。
        _ => Permission::Granted,
    })
}

/// 请求授权；已决定过时系统直接返回当前结果而不再弹窗。
pub fn request_permission() -> Result<Permission, String> {
    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        let result = match unsafe { error.as_ref() } {
            Some(error) => Err(error.localizedDescription().to_string()),
            None => Ok(granted.as_bool()),
        };
        let _ = sender.send(result);
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &handler,
        );
    match receiver.recv_timeout(AUTHORIZATION_TIMEOUT) {
        Ok(Ok(true)) => Ok(Permission::Granted),
        Ok(Ok(false)) => Ok(Permission::Denied),
        Ok(Err(error)) => Err(format!("E:os_failed:{error}")),
        Err(_) => permission(),
    }
}

/// 投递一条通知。未决定权限时先请求授权；被拒绝返回 `E:permission_denied`。
pub fn show(title: &str, body: &str) -> Result<(), String> {
    match permission()? {
        Permission::Granted => {}
        Permission::Denied => return Err("E:permission_denied".into()),
        Permission::NotDetermined => {
            if request_permission()? != Permission::Granted {
                return Err("E:permission_denied".into());
            }
        }
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let identifier = NSString::from_str(&uuid::Uuid::new_v4().to_string());
    let request =
        UNNotificationRequest::requestWithIdentifier_content_trigger(&identifier, &content, None);

    let (sender, receiver) = mpsc::channel();
    let handler = RcBlock::new(move |error: *mut NSError| {
        let result = match unsafe { error.as_ref() } {
            Some(error) => Err(format!("E:os_failed:{}", error.localizedDescription())),
            None => Ok(()),
        };
        let _ = sender.send(result);
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&handler));
    receiver
        .recv_timeout(QUERY_TIMEOUT)
        .map_err(|_| "E:os_failed:notification request timed out".to_string())?
}
