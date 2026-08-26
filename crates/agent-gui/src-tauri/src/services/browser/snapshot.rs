//! a11y snapshot：`Accessibility.getFullAXTree` → 缩进文本（aria-snapshot 风格），
//! 可交互/有名字的节点分配 ref id（e1, e2…），ref→backendDOMNodeId 映射由调用方
//! 保存到会话状态供 click/type 使用。目标是 token 效率：过滤 ignored 与无信息节点。

use std::collections::HashMap;

use serde_json::Value;

pub(crate) struct SnapshotOutcome {
    pub text: String,
    pub ref_to_backend_node: HashMap<String, i64>,
}

/// 值得保留 ref 的角色：可交互或常作定位锚点。
fn is_interactive_role(role: &str) -> bool {
    matches!(
        role,
        "button"
            | "link"
            | "textbox"
            | "searchbox"
            | "checkbox"
            | "radio"
            | "combobox"
            | "listbox"
            | "option"
            | "menuitem"
            | "menuitemcheckbox"
            | "menuitemradio"
            | "tab"
            | "slider"
            | "spinbutton"
            | "switch"
    )
}

/// 纯结构性角色：无名字时直接拍平（子节点上提一层），省缩进与行数。
fn is_structural_role(role: &str) -> bool {
    matches!(
        role,
        "none" | "generic" | "InlineTextBox" | "LineBreak" | "presentation"
    )
}

struct AxNode {
    role: String,
    name: String,
    backend_node_id: Option<i64>,
    child_ids: Vec<String>,
    ignored: bool,
    extras: Vec<String>,
}

fn parse_node(raw: &Value) -> Option<(String, AxNode)> {
    let node_id = raw.get("nodeId")?.as_str()?.to_string();
    let ignored = raw.get("ignored").and_then(Value::as_bool).unwrap_or(false);
    let role = raw
        .pointer("/role/value")
        .and_then(Value::as_str)
        .unwrap_or("generic")
        .to_string();
    let name = raw
        .pointer("/name/value")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let backend_node_id = raw.get("backendDOMNodeId").and_then(Value::as_i64);
    let child_ids = raw
        .get("childIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    // 少量高价值属性：选中/勾选/禁用/展开状态与输入值。
    let mut extras = Vec::new();
    if let Some(properties) = raw.get("properties").and_then(Value::as_array) {
        for property in properties {
            let Some(prop_name) = property.get("name").and_then(Value::as_str) else {
                continue;
            };
            let prop_value = property.pointer("/value/value");
            match prop_name {
                "checked" | "selected" | "expanded" | "pressed" | "disabled" => match prop_value {
                    Some(Value::Bool(true)) => extras.push(prop_name.to_string()),
                    Some(Value::String(state)) if state != "false" => {
                        extras.push(format!("{prop_name}={state}"))
                    }
                    _ => {}
                },
                "valuetext" => {
                    if let Some(Value::String(text)) = prop_value {
                        if !text.is_empty() {
                            extras.push(format!("value={text}"));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    Some((
        node_id,
        AxNode {
            role,
            name,
            backend_node_id,
            child_ids,
            ignored,
            extras,
        },
    ))
}

/// 将 `Accessibility.getFullAXTree` 的 nodes 数组渲染为缩进文本。
pub(crate) fn render_ax_tree(nodes: &[Value], max_chars: usize) -> SnapshotOutcome {
    let mut by_id: HashMap<String, AxNode> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for raw in nodes {
        if let Some((id, node)) = parse_node(raw) {
            order.push(id.clone());
            by_id.insert(id, node);
        }
    }
    // 根 = 第一个未被任何节点引用为 child 的节点（CDP 通常首元素即根）。
    let mut referenced: HashMap<&str, bool> = HashMap::new();
    for node in by_id.values() {
        for child in &node.child_ids {
            referenced.insert(child.as_str(), true);
        }
    }
    let root_id = order
        .iter()
        .find(|id| !referenced.contains_key(id.as_str()))
        .cloned();

    let mut text = String::new();
    let mut ref_map = HashMap::new();
    let mut next_ref = 1usize;
    let mut truncated = false;
    if let Some(root_id) = root_id {
        render_node(
            &by_id,
            &root_id,
            0,
            &mut text,
            &mut ref_map,
            &mut next_ref,
            max_chars,
            &mut truncated,
        );
    }
    if truncated {
        text.push_str("- (snapshot truncated)\n");
    }
    SnapshotOutcome {
        text,
        ref_to_backend_node: ref_map,
    }
}

#[allow(clippy::too_many_arguments)]
fn render_node(
    by_id: &HashMap<String, AxNode>,
    node_id: &str,
    depth: usize,
    out: &mut String,
    ref_map: &mut HashMap<String, i64>,
    next_ref: &mut usize,
    max_chars: usize,
    truncated: &mut bool,
) {
    if *truncated || out.len() >= max_chars {
        *truncated = true;
        return;
    }
    let Some(node) = by_id.get(node_id) else {
        return;
    };

    // ignored / 无名结构节点：拍平，子节点保持当前缩进。
    let flatten = node.ignored || (is_structural_role(&node.role) && node.name.is_empty());
    // 无名、无属性、无 backendNode 的纯文本容器行也没有信息量，但仍需下钻子树。
    let emit = !flatten && (!node.name.is_empty() || is_interactive_role(&node.role) || depth == 0);

    let child_depth = if emit { depth + 1 } else { depth };
    if emit {
        out.push_str(&"  ".repeat(depth));
        out.push_str("- ");
        out.push_str(&node.role);
        if !node.name.is_empty() {
            let name = if node.name.chars().count() > 120 {
                let mut clipped: String = node.name.chars().take(120).collect();
                clipped.push('…');
                clipped
            } else {
                node.name.clone()
            };
            out.push_str(&format!(" \"{name}\""));
        }
        for extra in &node.extras {
            out.push_str(&format!(" [{extra}]"));
        }
        if is_interactive_role(&node.role) {
            if let Some(backend_node_id) = node.backend_node_id {
                let ref_id = format!("e{}", *next_ref);
                *next_ref += 1;
                ref_map.insert(ref_id.clone(), backend_node_id);
                out.push_str(&format!(" [ref={ref_id}]"));
            }
        }
        out.push('\n');
    }
    for child_id in &node.child_ids {
        render_node(
            by_id,
            child_id,
            child_depth,
            out,
            ref_map,
            next_ref,
            max_chars,
            truncated,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renders_interactive_nodes_with_refs_and_flattens_generic() {
        let nodes = vec![
            json!({
                "nodeId": "1", "ignored": false,
                "role": {"value": "RootWebArea"}, "name": {"value": "Example"},
                "childIds": ["2"]
            }),
            json!({
                "nodeId": "2", "ignored": false,
                "role": {"value": "generic"}, "name": {"value": ""},
                "childIds": ["3", "4"]
            }),
            json!({
                "nodeId": "3", "ignored": false,
                "role": {"value": "button"}, "name": {"value": "Submit"},
                "backendDOMNodeId": 42, "childIds": []
            }),
            json!({
                "nodeId": "4", "ignored": true,
                "role": {"value": "link"}, "name": {"value": "hidden"},
                "backendDOMNodeId": 43, "childIds": []
            }),
        ];
        let outcome = render_ax_tree(&nodes, 8_000);
        assert!(outcome.text.contains("RootWebArea \"Example\""));
        assert!(outcome.text.contains("button \"Submit\" [ref=e1]"));
        assert!(!outcome.text.contains("hidden"));
        assert_eq!(outcome.ref_to_backend_node.get("e1"), Some(&42));
    }

    #[test]
    fn truncates_at_char_budget() {
        let mut nodes = vec![json!({
            "nodeId": "1", "ignored": false,
            "role": {"value": "RootWebArea"}, "name": {"value": "Big"},
            "childIds": (2..200).map(|i| i.to_string()).collect::<Vec<_>>()
        })];
        for i in 2..200 {
            nodes.push(json!({
                "nodeId": i.to_string(), "ignored": false,
                "role": {"value": "link"}, "name": {"value": format!("item number {i}")},
                "backendDOMNodeId": i, "childIds": []
            }));
        }
        let outcome = render_ax_tree(&nodes, 500);
        assert!(outcome.text.len() < 700);
        assert!(outcome.text.contains("snapshot truncated"));
    }
}
