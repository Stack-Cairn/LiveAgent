//! SkillsManager 入口：payload 动作解析与 `system_manage_skill_sync` 分发。

use serde_json::Value;

use super::*;

pub(crate) fn action_from_payload(
    payload: &serde_json::Map<String, Value>,
) -> Result<String, String> {
    let action = object_string(payload, "action").unwrap_or_else(|| {
        if object_string(payload, "path").is_some() {
            "read"
        } else {
            "list"
        }
    });
    match action {
        "read" | "list" | "install" | "install_start" | "install_status" | "install_cancel"
        | "create" | "validate" | "package" | "delete" | "clawhub_search" | "clawhub_install"
        | "scan_external" => Ok(action.to_string()),
        _ => Err(format!("SkillsManager action is not supported: {action}")),
    }
}

fn require_payload_string<'a>(
    payload: &'a serde_json::Map<String, Value>,
    key: &str,
    action: &str,
) -> Result<&'a str, String> {
    object_string(payload, key)
        .ok_or_else(|| format!("SkillsManager {action} requires {key}"))
}

pub fn system_manage_skill_sync(payload: Value) -> Result<SystemManageSkillResponse, String> {
    let root = skills_root_dir()?;
    let root_dir = skill_root_display(&root);
    let payload = payload
        .as_object()
        .ok_or_else(|| "SkillsManager payload must be an object".to_string())?;
    let action = action_from_payload(payload)?;
    let base = SystemManageSkillResponse::base(action.clone(), root_dir);

    match action.as_str() {
        "read" => {
            let path = require_payload_string(payload, "path", "read")?;
            let offset = object_usize(payload, "offset");
            let length = object_usize(payload, "length");
            let result = read_skill_text_from_root(&root, path, offset, length)?;
            let num_lines = result.content.match_indices('\n').count()
                + usize::from(!result.content.is_empty() && !result.content.ends_with('\n'));
            Ok(SystemManageSkillResponse {
                path: Some(path.to_string()),
                content: Some(result.content),
                truncated: Some(result.truncated),
                start_line: Some(offset.unwrap_or(0) + 1),
                num_lines: Some(num_lines),
                ..base
            })
        }
        "list" => {
            let (skills, invalid) = list_installed_skills(&root)?;
            Ok(SystemManageSkillResponse {
                skills: Some(skills),
                invalid: Some(invalid),
                ..base
            })
        }
        "scan_external" => Ok(SystemManageSkillResponse {
            external: Some(scan_external_skills()),
            ..base
        }),
        "clawhub_search" => {
            let (clawhub_results, clawhub_next_cursor) =
                search_clawhub_skills_from_payload(payload)?;
            Ok(SystemManageSkillResponse {
                clawhub_results: Some(clawhub_results),
                clawhub_next_cursor,
                ..base
            })
        }
        "install" => Ok(SystemManageSkillResponse {
            installed: Some(install_source_from_payload(&root, payload)?),
            ..base
        }),
        "clawhub_install" => {
            let (installed, slug, download_url) =
                install_clawhub_skill_from_payload(&root, payload)?;
            Ok(SystemManageSkillResponse {
                installed: Some(installed),
                clawhub_slug: Some(slug),
                clawhub_download_url: Some(download_url),
                ..base
            })
        }
        "install_start" => Ok(SystemManageSkillResponse {
            install_job: Some(start_install_job_from_payload(root.clone(), payload)?),
            ..base
        }),
        "install_status" => {
            let job_id = object_string(payload, "jobId")
                .or_else(|| object_string(payload, "job_id"))
                .ok_or_else(|| "SkillsManager install_status requires jobId".to_string())?;
            Ok(SystemManageSkillResponse {
                install_job: Some(get_install_job_snapshot(job_id)?),
                ..base
            })
        }
        "install_cancel" => {
            let job_id = object_string(payload, "jobId")
                .or_else(|| object_string(payload, "job_id"))
                .ok_or_else(|| "SkillsManager install_cancel requires jobId".to_string())?;
            Ok(SystemManageSkillResponse {
                install_job: Some(cancel_install_job(job_id)?),
                ..base
            })
        }
        "create" => Ok(SystemManageSkillResponse {
            created: Some(create_skill_from_payload(&root, payload)?),
            ..base
        }),
        "validate" => {
            let name = require_payload_string(payload, "name", "validate")?;
            Ok(SystemManageSkillResponse {
                validation: Some(validate_installed_skill(&root, name)?),
                ..base
            })
        }
        "package" => {
            let name = require_payload_string(payload, "name", "package")?;
            Ok(SystemManageSkillResponse {
                package: Some(package_installed_skill(&root, name)?),
                ..base
            })
        }
        "delete" => {
            let name = require_payload_string(payload, "name", "delete")?;
            Ok(SystemManageSkillResponse {
                deleted: Some(delete_installed_skill(&root, name)?),
                ..base
            })
        }
        _ => Err(format!("SkillsManager action is not supported: {action}")),
    }
}
