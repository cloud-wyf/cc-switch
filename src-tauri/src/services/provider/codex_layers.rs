//! Codex 公共配置和供应商私有覆盖的 TOML 读写。

use std::collections::HashSet;

use serde_json::{json, Value};
use toml_edit::{DocumentMut, Item};

use crate::error::AppError;
use crate::live::floor;
use crate::live::project::claude::PROXY_TOKEN_PLACEHOLDER;
use crate::live::project::codex::{OFFICIAL_PROXY_ROUTE_ID, ROUTE_ID};

use super::editor_toml::{insert_at, item_at, remove_at, render, Entry};

const PRIVATE_DELETES: &str = "codexPrivateDeletes";

#[derive(Debug, Clone)]
pub(crate) struct LayerUpdate {
    pub common_config: String,
    pub private_config: DocumentMut,
    pub private_deletes: Vec<Vec<String>>,
    pub changed: bool,
}

pub(crate) fn config_text(settings: &Value) -> &str {
    settings.get("config").and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn entries(doc: &DocumentMut, skip_routes: &[&str]) -> Vec<Entry> {
    let mut entries = Vec::new();
    for (key, item) in doc.as_table().iter() {
        if floor::CODEX_FLOOR_TOP.contains(&key) || floor::CODEX_EXCLUSIVE_TOP.contains(&key) {
            continue;
        }
        if key == "model_providers" {
            if let Some(providers) = item.as_table_like() {
                for (id, table) in providers.iter() {
                    if id == ROUTE_ID
                        || id == OFFICIAL_PROXY_ROUTE_ID
                        || skip_routes.contains(&id)
                        || holds_proxy_placeholder(table)
                    {
                        continue;
                    }
                    let mut path = vec![key.to_string(), id.to_string()];
                    collect_entries(table, &mut path, &mut entries);
                }
            }
            continue;
        }
        if key == "profiles" {
            if let Some(profiles) = item.as_table_like() {
                for (profile, table) in profiles.iter() {
                    let Some(table) = table.as_table_like() else {
                        continue;
                    };
                    for (field, value) in table.iter() {
                        if field == "model_provider" {
                            continue;
                        }
                        let mut path =
                            vec![key.to_string(), profile.to_string(), field.to_string()];
                        collect_entries(value, &mut path, &mut entries);
                    }
                }
            }
            continue;
        }
        collect_entries(item, &mut vec![key.to_string()], &mut entries);
    }
    entries
}

fn provider_private_entries(doc: &DocumentMut, skip_routes: &[&str]) -> Vec<Entry> {
    entries(doc, skip_routes)
        .into_iter()
        .filter(|entry| entry.path.first().is_some_and(|key| key != "mcp_servers"))
        .collect()
}

fn holds_proxy_placeholder(item: &Item) -> bool {
    item.as_table_like()
        .and_then(|table| table.get("experimental_bearer_token"))
        .and_then(Item::as_str)
        == Some(PROXY_TOKEN_PLACEHOLDER)
}

fn collect_entries(item: &Item, path: &mut Vec<String>, entries: &mut Vec<Entry>) {
    let Some(table) = item.as_table_like() else {
        entries.push(Entry {
            path: path.clone(),
            item: item.clone(),
        });
        return;
    };

    let mut has_children = false;
    for (key, child) in table.iter() {
        has_children = true;
        if path.len() == 1 && is_nested_floor(&path[0], key) {
            continue;
        }
        path.push(key.to_string());
        collect_entries(child, path, entries);
        path.pop();
    }
    if !has_children {
        entries.push(Entry {
            path: path.clone(),
            item: item.clone(),
        });
    }
}

fn is_nested_floor(parent: &str, key: &str) -> bool {
    floor::CODEX_FLOOR_NESTED
        .iter()
        .any(|segments| segments.len() == 2 && segments[0] == parent && segments[1] == key)
}

fn selected_route(doc: &DocumentMut) -> Option<&str> {
    doc.get("model_provider").and_then(Item::as_str)
}

fn remove_at_prune(doc: &mut DocumentMut, path: &[String]) {
    remove_at(doc, path);
    for depth in (1..path.len()).rev() {
        let parent = &path[..depth];
        let empty = item_at(doc, parent)
            .and_then(Item::as_table_like)
            .is_some_and(|table| table.iter().next().is_none());
        if !empty {
            break;
        }
        remove_at(doc, parent);
    }
}

fn parse(text: &str, what: &str) -> Result<DocumentMut, AppError> {
    text.parse::<DocumentMut>()
        .map_err(|error| AppError::Message(format!("Codex {what}配置不是合法 TOML：{error}")))
}

fn private_deletes(settings: &Value) -> Vec<Vec<String>> {
    settings
        .get(PRIVATE_DELETES)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|path| {
            path.as_array().and_then(|segments| {
                let parsed: Option<Vec<String>> = segments
                    .iter()
                    .map(|segment| segment.as_str().map(str::to_string))
                    .collect();
                parsed.filter(|segments| !segments.is_empty())
            })
        })
        .collect()
}

fn map_entries(entries: Vec<Entry>) -> Vec<(Vec<String>, Item)> {
    entries
        .into_iter()
        .map(|entry| (entry.path, entry.item))
        .collect()
}

fn find<'a>(entries: &'a [(Vec<String>, Item)], path: &[String]) -> Option<&'a Item> {
    entries
        .iter()
        .find(|(entry_path, _)| entry_path == path)
        .map(|(_, item)| item)
}

fn put(entries: &mut Vec<(Vec<String>, Item)>, path: &[String], item: Option<Item>) {
    entries.retain(|(entry_path, _)| entry_path != path);
    if let Some(item) = item {
        entries.push((path.to_vec(), item));
    }
}

fn overlay(common: &DocumentMut, private: &DocumentMut, deletes: &[Vec<String>]) -> DocumentMut {
    let mut result = common.clone();
    let private_route = selected_route(private).into_iter().collect::<Vec<_>>();
    for entry in provider_private_entries(private, &private_route) {
        insert_at(&mut result, &entry.path, entry.item);
    }
    for path in deletes {
        remove_at_prune(&mut result, path);
    }
    result
}

pub(crate) fn effective_entries(
    common_text: &str,
    settings: &Value,
) -> Result<Vec<Entry>, AppError> {
    let common = parse(common_text, "公共")?;
    let private = parse(config_text(settings), "供应商私有").unwrap_or_default();
    let merged = overlay(&common, &private, &private_deletes(settings));
    let private_route = selected_route(&private).into_iter().collect::<Vec<_>>();
    Ok(entries(&merged, &private_route))
}

pub(crate) fn private_entries(settings: &Value) -> Result<Vec<Entry>, AppError> {
    let private = parse(config_text(settings), "供应商私有").unwrap_or_default();
    let route = selected_route(&private).into_iter().collect::<Vec<_>>();
    Ok(provider_private_entries(&private, &route))
}

pub(crate) fn delete_paths(settings: &Value) -> Vec<Vec<String>> {
    private_deletes(settings)
}

fn apply_change(
    common: &mut Vec<(Vec<String>, Item)>,
    private: &mut Vec<(Vec<String>, Item)>,
    deletes: &mut HashSet<Vec<String>>,
    path: &[String],
    after: Option<Item>,
) {
    let common_value = find(common, path).cloned();
    let private_exists = find(private, path).is_some() || deletes.contains(path);
    if private_exists {
        if after.as_ref().map(render) == common_value.as_ref().map(render) {
            put(private, path, None);
            deletes.remove(path);
        } else if let Some(item) = after {
            put(private, path, Some(item));
            deletes.remove(path);
        } else if common_value.is_some() {
            put(private, path, None);
            deletes.insert(path.to_vec());
        } else {
            put(private, path, None);
            deletes.remove(path);
        }
    } else {
        put(common, path, after);
    }
}

fn sorted_deletes(deletes: HashSet<Vec<String>>) -> Vec<Vec<String>> {
    let mut deletes: Vec<_> = deletes.into_iter().collect();
    deletes.sort();
    deletes
}

fn changed_paths(base: &[Entry], updated: &[Entry]) -> Vec<Vec<String>> {
    let mut paths: Vec<_> = base.iter().map(|entry| entry.path.clone()).collect();
    for entry in updated {
        if !paths.contains(&entry.path) {
            paths.push(entry.path.clone());
        }
    }
    paths
        .into_iter()
        .filter(|path| {
            let before = base
                .iter()
                .find(|entry| entry.path == *path)
                .map(|entry| render(&entry.item));
            let after = updated
                .iter()
                .find(|entry| entry.path == *path)
                .map(|entry| render(&entry.item));
            before != after
        })
        .collect()
}

fn write_items(doc: &mut DocumentMut, old: &DocumentMut, items: &[(Vec<String>, Item)]) {
    for entry in entries(old, &[]) {
        if find(items, &entry.path).is_none() {
            remove_at_prune(doc, &entry.path);
        }
    }
    for (path, item) in items {
        insert_at(doc, path, item.clone());
    }
}

pub(crate) fn apply_editor_changes(
    common_text: &str,
    settings: &Value,
    base: &DocumentMut,
    edited: &DocumentMut,
) -> Result<LayerUpdate, AppError> {
    let mut common = parse(common_text, "公共")?;
    let Ok(mut private) = parse(config_text(settings), "供应商私有") else {
        return Ok(LayerUpdate {
            common_config: common_text.to_string(),
            private_config: DocumentMut::new(),
            private_deletes: private_deletes(settings),
            changed: false,
        });
    };
    let mut common_items = map_entries(entries(&common, &[]));
    let private_route = selected_route(&private).into_iter().collect::<Vec<_>>();
    let mut private_items = map_entries(provider_private_entries(&private, &private_route));
    let mut deletes: HashSet<_> = private_deletes(settings).into_iter().collect();
    let routes: Vec<_> = [selected_route(base), selected_route(edited)]
        .into_iter()
        .flatten()
        .collect();
    let base_entries = entries(base, &routes);
    let edited_entries = entries(edited, &routes);
    let paths = changed_paths(&base_entries, &edited_entries);
    for path in &paths {
        let after = edited_entries
            .iter()
            .find(|entry| entry.path == *path)
            .map(|entry| entry.item.clone());
        apply_change(
            &mut common_items,
            &mut private_items,
            &mut deletes,
            path,
            after,
        );
    }
    write_items(&mut common, &parse(common_text, "公共")?, &common_items);
    private = DocumentMut::new();
    for (path, item) in &private_items {
        insert_at(&mut private, path, item.clone());
    }
    Ok(LayerUpdate {
        common_config: common.to_string(),
        private_config: private,
        private_deletes: sorted_deletes(deletes),
        changed: !paths.is_empty(),
    })
}

pub(crate) fn reconcile_disk(
    common_text: &str,
    settings: &Value,
    actual: &DocumentMut,
) -> Result<LayerUpdate, AppError> {
    let mut common = parse(common_text, "公共")?;
    let Ok(mut private) = parse(config_text(settings), "供应商私有") else {
        return Ok(LayerUpdate {
            common_config: common_text.to_string(),
            private_config: DocumentMut::new(),
            private_deletes: private_deletes(settings),
            changed: false,
        });
    };
    let mut common_items = map_entries(entries(&common, &[]));
    let private_route = selected_route(&private).into_iter().collect::<Vec<_>>();
    let mut private_items = map_entries(provider_private_entries(&private, &private_route));
    let mut deletes: HashSet<_> = private_deletes(settings).into_iter().collect();
    let effective = overlay(&common, &private, &sorted_deletes(deletes.clone()));
    let private_route = selected_route(&private).into_iter().collect::<Vec<_>>();
    let expected_entries = map_entries(entries(&effective, &private_route));
    let actual_route = selected_route(actual).into_iter().collect::<Vec<_>>();
    let actual_entries = map_entries(entries(actual, &actual_route));
    let mut paths: Vec<_> = expected_entries
        .iter()
        .map(|(path, _)| path.clone())
        .collect();
    for (path, _) in &actual_entries {
        if !paths.contains(path) {
            paths.push(path.clone());
        }
    }
    let mut changed = false;
    for path in paths {
        let expected = find(&expected_entries, &path);
        let actual = find(&actual_entries, &path).cloned();
        if expected.map(render) == actual.as_ref().map(render) {
            continue;
        }
        changed = true;
        apply_change(
            &mut common_items,
            &mut private_items,
            &mut deletes,
            &path,
            actual,
        );
    }
    if !changed {
        return Ok(LayerUpdate {
            common_config: common_text.to_string(),
            private_config: private,
            private_deletes: sorted_deletes(deletes),
            changed: false,
        });
    }
    write_items(&mut common, &parse(common_text, "公共")?, &common_items);
    private = DocumentMut::new();
    for (path, item) in &private_items {
        insert_at(&mut private, path, item.clone());
    }
    Ok(LayerUpdate {
        common_config: common.to_string(),
        private_config: private,
        private_deletes: sorted_deletes(deletes),
        changed: true,
    })
}

pub(crate) fn store_private_metadata(settings: &mut Value, deletes: &[Vec<String>]) {
    let Some(object) = settings.as_object_mut() else {
        return;
    };
    if deletes.is_empty() {
        object.remove(PRIVATE_DELETES);
    } else {
        object.insert(
            PRIVATE_DELETES.to_string(),
            Value::Array(deletes.iter().map(|path| json!(path)).collect()),
        );
    }
}

pub(crate) fn store_private_config(
    settings: &mut Value,
    private_config: &DocumentMut,
    deletes: &[Vec<String>],
) -> Result<(), AppError> {
    let mut row = parse(config_text(settings), "供应商")?;
    let route = selected_route(&row).into_iter().collect::<Vec<_>>();
    for entry in provider_private_entries(&row, &route) {
        remove_at_prune(&mut row, &entry.path);
    }
    for entry in entries(private_config, &[]) {
        insert_at(&mut row, &entry.path, entry.item);
    }
    if let Some(object) = settings.as_object_mut() {
        object.insert("config".to_string(), Value::String(row.to_string()));
    }
    store_private_metadata(settings, deletes);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(config: &str, deletes: Value) -> Value {
        json!({ "config": config, "codexPrivateDeletes": deletes })
    }

    #[test]
    fn editor_changes_update_public_or_existing_private_layer() {
        let common = "approval_policy = \"one\"\nfoo = 1\n";
        let row = settings("approval_policy = \"two\"\n", json!([]));
        let base: DocumentMut = "approval_policy = \"two\"\nfoo = 1\n".parse().unwrap();
        let edited: DocumentMut = "approval_policy = \"one\"\nfoo = 2\n".parse().unwrap();
        let update = apply_editor_changes(common, &row, &base, &edited).unwrap();
        assert!(!update
            .private_config
            .to_string()
            .contains("approval_policy"));
        assert!(update.common_config.contains("foo = 2"));
        assert!(update.private_deletes.is_empty());
    }

    #[test]
    fn nested_tables_are_merged_recursively() {
        let common = "[custom.fs]\ncommand = \"fs\"\nargs = [\"-c\"]\n\n[custom.fs.env]\nTOKEN = \"common\"\n";
        let row = settings(
            "[custom.fs]\nargs = [\"-p\"]\n\n[custom.fs.env]\nEXTRA = \"private\"\n",
            json!([]),
        );
        let entries = effective_entries(common, &row).unwrap();
        let values: Vec<_> = entries
            .iter()
            .map(|entry| (entry.path.join("."), render(&entry.item)))
            .collect();

        assert!(values
            .iter()
            .any(|(path, value)| { path == "custom.fs.command" && value.contains("fs") }));
        assert!(values
            .iter()
            .any(|(path, value)| { path == "custom.fs.args" && value.contains("-p") }));
        assert!(values.iter().any(|(path, _)| path == "custom.fs.env.TOKEN"));
        assert!(values.iter().any(|(path, _)| path == "custom.fs.env.EXTRA"));
    }

    #[test]
    fn provider_mcp_snapshots_are_ignored_but_common_mcp_is_projected() {
        let common = "[mcp_servers.common]\ncommand = \"common\"\n";
        let row = settings("[mcp_servers.private]\ncommand = \"private\"\n", json!([]));
        let entries = effective_entries(common, &row).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].path,
            ["mcp_servers", "common", "command"].map(str::to_string)
        );
    }

    #[test]
    fn disk_reconcile_updates_nested_public_and_private_values_independently() {
        let common = "[agents]\nmax_threads = 4\ntimeout = 1\n";
        let row = settings("[agents]\nmax_threads = 8\n", json!([]));
        let actual: DocumentMut = "[agents]\nmax_threads = 9\ntimeout = 2\n".parse().unwrap();
        let update = reconcile_disk(common, &row, &actual).unwrap();

        assert!(update.common_config.contains("max_threads = 4"));
        assert!(update.common_config.contains("timeout = 2"));
        assert!(update
            .private_config
            .to_string()
            .contains("max_threads = 9"));
    }

    #[test]
    fn reconcile_ignores_the_selected_provider_route_table() {
        let common =
            "[model_providers.relay]\nname = \"Relay\"\nbase_url = \"https://relay.example\"\n";
        let row = settings(
            "model_provider = \"relay\"\n\n[model_providers.relay]\nname = \"Relay\"\nbase_url = \"https://relay.example\"\n",
            json!([]),
        );
        let actual: DocumentMut = "model_provider = \"relay\"\n\n[model_providers.relay]\nname = \"Relay\"\nbase_url = \"https://relay.example\"\n".parse().unwrap();
        let update = reconcile_disk(common, &row, &actual).unwrap();

        assert!(!update.changed);
    }

    #[test]
    fn profile_provider_routes_are_not_shared_or_projected() {
        let common = "[profiles.work]\nmodel_provider = \"common-route\"\nmodel = \"gpt-5\"\n";
        let row = settings(
            "[profiles.work]\nmodel_provider = \"private-route\"\nmodel = \"gpt-5-mini\"\n",
            json!([]),
        );
        let entries = effective_entries(common, &row).unwrap();

        assert!(entries
            .iter()
            .any(|entry| { entry.path == ["profiles", "work", "model"].map(str::to_string) }));
        assert!(!entries.iter().any(|entry| {
            entry.path == ["profiles", "work", "model_provider"].map(str::to_string)
        }));
    }

    #[test]
    fn malformed_legacy_provider_config_does_not_block_disk_reconciliation() {
        let common = "approval_policy = \"on-request\"\n";
        let row = settings("legacy-unparsed-config", json!([]));
        let actual: DocumentMut = "approval_policy = \"never\"\n".parse().unwrap();

        let entries = effective_entries(common, &row).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, vec!["approval_policy"]);
        assert!(private_entries(&row).unwrap().is_empty());
        assert!(!reconcile_disk(common, &row, &actual).unwrap().changed);
    }

    #[test]
    fn disk_reconcile_updates_override_or_removes_it_when_equal_to_common() {
        let common = "approval_policy = \"one\"\n";
        let row = settings("approval_policy = \"two\"\n", json!([]));
        let actual: DocumentMut = "approval_policy = \"three\"\n".parse().unwrap();
        let update = reconcile_disk(common, &row, &actual).unwrap();
        assert!(update.private_config.to_string().contains("three"));
        assert!(update.common_config.contains("one"));

        let actual: DocumentMut = "approval_policy = \"one\"\n".parse().unwrap();
        let update = reconcile_disk(common, &row, &actual).unwrap();
        assert!(update.private_config.to_string().trim().is_empty());
        assert!(update.private_deletes.is_empty());
    }

    #[test]
    fn deleting_an_overridden_public_value_creates_a_tombstone() {
        let common = "approval_policy = \"one\"\n";
        let row = settings("approval_policy = \"two\"\n", json!([]));
        let actual = DocumentMut::new();
        let update = reconcile_disk(common, &row, &actual).unwrap();
        assert_eq!(
            update.private_deletes,
            vec![vec!["approval_policy".to_string()]]
        );
        assert!(update.common_config.contains("one"));
    }
}
