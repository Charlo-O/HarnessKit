use axum::Json;
use axum::extract::State;
use hk_core::{HkError, models::*, sync};
use serde::Deserialize;

use crate::router::{ApiError, blocking};
use crate::state::WebState;

type Result<T> = std::result::Result<Json<T>, ApiError>;

#[derive(Deserialize)]
pub struct SaveSyncConfigInput {
    pub repo_url: String,
    pub branch: String,
    pub sync_skills: bool,
    pub sync_mcp: bool,
    pub sync_hooks: bool,
    pub token: Option<String>,
}

#[derive(Deserialize)]
pub struct TestConnectionInput {
    pub repo_url: String,
    pub token: String,
}

pub async fn sync_get_config(State(state): State<WebState>) -> Result<Option<SyncConfig>> {
    blocking(move || {
        let store = state.store.lock();
        store.get_sync_config()
    })
    .await
}

pub async fn sync_has_token(State(_state): State<WebState>) -> Result<bool> {
    blocking(move || Ok(sync::get_token()?.is_some())).await
}

pub async fn sync_save_config(
    State(state): State<WebState>,
    Json(config): Json<SaveSyncConfigInput>,
) -> Result<()> {
    blocking(move || {
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
    })
    .await
}

pub async fn sync_test_connection(
    State(_state): State<WebState>,
    Json(params): Json<TestConnectionInput>,
) -> Result<String> {
    blocking(move || sync::test_connection(&params.repo_url, &params.token)).await
}

pub async fn sync_push(State(state): State<WebState>) -> Result<SyncSummary> {
    blocking(move || {
        let store = state.store.lock();
        let config = store
            .get_sync_config()?
            .ok_or_else(|| HkError::Validation("Sync not configured".into()))?;
        let data_dir = dirs::home_dir()
            .ok_or_else(|| HkError::Internal("Cannot determine home directory".into()))?
            .join(".harnesskit");

        let summary = sync::push(&config, &state.adapters, &data_dir)?;
        store.record_sync_summary(&serde_json::to_string(&summary).unwrap_or_default())?;
        Ok(summary)
    })
    .await
}

pub async fn sync_pull(State(state): State<WebState>) -> Result<SyncSummary> {
    blocking(move || {
        let store = state.store.lock();
        let config = store
            .get_sync_config()?
            .ok_or_else(|| HkError::Validation("Sync not configured".into()))?;
        let data_dir = dirs::home_dir()
            .ok_or_else(|| HkError::Internal("Cannot determine home directory".into()))?
            .join(".harnesskit");

        let summary = sync::pull(&config, &state.adapters, &data_dir)?;
        store.record_sync_summary(&serde_json::to_string(&summary).unwrap_or_default())?;
        Ok(summary)
    })
    .await
}

#[derive(Deserialize)]
pub struct SyncToAgentsInput {
    pub items: Vec<AgentSyncItem>,
}

pub async fn sync_to_agents(
    State(state): State<WebState>,
    Json(params): Json<SyncToAgentsInput>,
) -> Result<AgentSyncSummary> {
    blocking(move || hk_core::service::sync_to_agents(&state.store, &state.adapters, &params.items))
        .await
}
