use super::AppState;
use hk_core::{models::*, sync, HkError};
use tauri::State;

#[derive(serde::Deserialize)]
pub struct SaveSyncConfigInput {
    pub repo_url: String,
    pub branch: String,
    pub sync_skills: bool,
    pub sync_mcp: bool,
    pub sync_hooks: bool,
    pub token: Option<String>,
}

#[tauri::command]
pub fn sync_get_config(state: State<AppState>) -> Result<Option<SyncConfig>, HkError> {
    let store = state.store.lock();
    store.get_sync_config()
}

#[tauri::command]
pub fn sync_has_token() -> Result<bool, HkError> {
    Ok(sync::get_token()?.is_some())
}

#[tauri::command]
pub async fn sync_save_config(
    state: State<'_, AppState>,
    config: SaveSyncConfigInput,
) -> Result<(), HkError> {
    // Store token in keychain if provided
    if let Some(ref token) = config.token {
        if token.is_empty() {
            sync::delete_token()?;
        } else {
            sync::store_token(token)?;
        }
    }

    let sync_config = SyncConfig {
        repo_url: config.repo_url,
        branch: config.branch,
        auth_type: "token".into(),
        sync_skills: config.sync_skills,
        sync_mcp: config.sync_mcp,
        sync_hooks: config.sync_hooks,
        last_sync_at: None,
        last_sync_summary: None,
    };

    let store = state.store.lock();
    store.save_sync_config(&sync_config)?;
    Ok(())
}

#[tauri::command]
pub async fn sync_test_connection(repo_url: String, token: String) -> Result<String, HkError> {
    tauri::async_runtime::spawn_blocking(move || sync::test_connection(&repo_url, &token))
        .await
        .map_err(|e| HkError::Internal(e.to_string()))?
}

#[tauri::command]
pub async fn sync_push(state: State<'_, AppState>) -> Result<SyncSummary, HkError> {
    let store_arc = state.store.clone();
    let adapters = state.adapters.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let store = store_arc.lock();
        let config = store
            .get_sync_config()?
            .ok_or_else(|| HkError::Validation("Sync not configured".into()))?;

        let data_dir = dirs::home_dir()
            .ok_or_else(|| HkError::Internal("Cannot determine home directory".into()))?
            .join(".harnesskit");

        let summary = sync::push(&config, &adapters, &data_dir)?;
        store.record_sync_summary(&serde_json::to_string(&summary).unwrap_or_default())?;
        Ok(summary)
    })
    .await
    .map_err(|e| HkError::Internal(e.to_string()))?
}

#[tauri::command]
pub async fn sync_pull(state: State<'_, AppState>) -> Result<SyncSummary, HkError> {
    let store_arc = state.store.clone();
    let adapters = state.adapters.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let store = store_arc.lock();
        let config = store
            .get_sync_config()?
            .ok_or_else(|| HkError::Validation("Sync not configured".into()))?;

        let data_dir = dirs::home_dir()
            .ok_or_else(|| HkError::Internal("Cannot determine home directory".into()))?
            .join(".harnesskit");

        let summary = sync::pull(&config, &adapters, &data_dir)?;
        store.record_sync_summary(&serde_json::to_string(&summary).unwrap_or_default())?;
        Ok(summary)
    })
    .await
    .map_err(|e| HkError::Internal(e.to_string()))?
}

#[tauri::command]
pub async fn sync_to_agents(
    state: State<'_, AppState>,
    items: Vec<AgentSyncItem>,
) -> Result<AgentSyncSummary, HkError> {
    let store = state.store.clone();
    let adapters = state.adapters.clone();
    tauri::async_runtime::spawn_blocking(move || {
        hk_core::service::sync_to_agents(&store, &adapters, &items)
    })
    .await
    .map_err(|e| HkError::Internal(e.to_string()))?
}
