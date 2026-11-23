/**
 * Messages for in-app confirmation dialogs (the shared promise-based
 * ConfirmDialog). Each confirmation states its consequence in the title and
 * names the action on the confirm button instead of a bare "OK".
 */
export const CONFIRM_DIALOG_TRANSLATIONS = {
  "zh-CN": {
    "confirmDialog.keepEditing": "继续编辑",
    "imageSettings.confirm.leaveTitle": "离开图像设置？",
    "imageSettings.confirm.leaveDescription":
      "图像设置有未保存的修改或正在等待的操作。离开将丢弃本页草稿；已发出的请求可能仍会完成。",
    "imageSettings.confirm.leave": "放弃并离开",
    "imageSettings.confirm.switchConnectionTitle": "切换连接？",
    "imageSettings.confirm.switchConnectionDescription": "切换连接将清空尚未写入的凭据。",
    "imageSettings.confirm.switchConnection": "清空并切换",
    "imageSettings.confirm.addConnectionTitle": "新增连接？",
    "imageSettings.confirm.addConnectionDescription": "新增连接将清空尚未写入的凭据。",
    "imageSettings.confirm.addConnection": "清空并新增",
    "imageSettings.confirm.cancelEditsTitle": "放弃未保存的修改？",
    "imageSettings.confirm.cancelEditsDescription": "未保存的图像设置和凭据输入将被丢弃。",
    "imageSettings.confirm.cancelEdits": "放弃修改",
    "imageSettings.confirm.mergeTitle": "合并到最新版本？",
    "imageSettings.confirm.mergeDescriptionLocal":
      "有 {count} 个连接或目标被同时修改。冲突项将使用我的草稿，其余远端修改会保留。",
    "imageSettings.confirm.mergeDescriptionRemote":
      "有 {count} 个连接或目标被同时修改。冲突项将使用服务器版本，其余远端修改会保留。",
    "imageSettings.confirm.merge": "合并",
    "imageSettings.confirm.adoptRemoteTitle": "采用服务器全部设置？",
    "imageSettings.confirm.adoptRemoteDescription": "本地草稿将被丢弃，改用服务器上的全部设置。",
    "imageSettings.confirm.adoptRemote": "丢弃草稿并采用",
    "imageSettings.confirm.deleteConnectionTitle": "删除连接“{name}”？",
    "imageSettings.confirm.deleteTargetTitle": "删除目标“{name}”？",
    "imageSettings.confirm.deleteDescription": "保存设置后生效。",
    "imageSettings.confirm.delete": "删除",
  },
  "en-US": {
    "confirmDialog.keepEditing": "Keep editing",
    "imageSettings.confirm.leaveTitle": "Leave image settings?",
    "imageSettings.confirm.leaveDescription":
      "Image settings have unsaved changes or a pending operation. Leaving discards the draft on this page; requests already sent may still complete.",
    "imageSettings.confirm.leave": "Discard and leave",
    "imageSettings.confirm.switchConnectionTitle": "Switch connection?",
    "imageSettings.confirm.switchConnectionDescription":
      "Switching connections clears the credential you have not written yet.",
    "imageSettings.confirm.switchConnection": "Clear and switch",
    "imageSettings.confirm.addConnectionTitle": "Add a connection?",
    "imageSettings.confirm.addConnectionDescription":
      "Adding a connection clears the credential you have not written yet.",
    "imageSettings.confirm.addConnection": "Clear and add",
    "imageSettings.confirm.cancelEditsTitle": "Discard unsaved changes?",
    "imageSettings.confirm.cancelEditsDescription":
      "Unsaved image settings and credential input will be discarded.",
    "imageSettings.confirm.cancelEdits": "Discard changes",
    "imageSettings.confirm.mergeTitle": "Merge into the latest version?",
    "imageSettings.confirm.mergeDescriptionLocal":
      "{count} connections or targets were changed on both sides. Conflicts keep your draft; other server changes are kept.",
    "imageSettings.confirm.mergeDescriptionRemote":
      "{count} connections or targets were changed on both sides. Conflicts take the server version; other server changes are kept.",
    "imageSettings.confirm.merge": "Merge",
    "imageSettings.confirm.adoptRemoteTitle": "Use all server settings?",
    "imageSettings.confirm.adoptRemoteDescription":
      "Your local draft will be discarded and replaced with the settings on the server.",
    "imageSettings.confirm.adoptRemote": "Discard draft and use server",
    "imageSettings.confirm.deleteConnectionTitle": "Delete connection “{name}”?",
    "imageSettings.confirm.deleteTargetTitle": "Delete target “{name}”?",
    "imageSettings.confirm.deleteDescription": "Takes effect after you save settings.",
    "imageSettings.confirm.delete": "Delete",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
