//! Git-based sync engine for pushing/pulling Skills, MCP configs, and Hooks
//! to/from a remote Git repository.

use crate::HkError;
use crate::adapter::AgentAdapter;
use crate::models::{SyncConfig, SyncSummary};
use std::path::{Path, PathBuf};

/// Keyring service name for storing the Git auth token.
const KEYRING_SERVICE: &str = "com.harnesskit.sync";
const KEYRING_USER: &str = "git-token";

/// Create a `Command` that does NOT flash a console window on Windows.
#[cfg(target_os = "windows")]
fn silent_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

#[cfg(not(target_os = "windows"))]
fn silent_command(program: &str) -> std::process::Command {
    std::process::Command::new(program)
}

// ---------------------------------------------------------------------------
// Token management (OS keychain)
// ---------------------------------------------------------------------------

/// Store the auth token in the OS keychain.
pub fn store_token(token: &str) -> Result<(), HkError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| HkError::Internal(format!("Keyring init failed: {e}")))?;
    entry
        .set_password(token)
        .map_err(|e| HkError::Internal(format!("Failed to store token: {e}")))?;
    Ok(())
}

/// Retrieve the auth token from the OS keychain.
pub fn get_token() -> Result<Option<String>, HkError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| HkError::Internal(format!("Keyring init failed: {e}")))?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(HkError::Internal(format!("Failed to read token: {e}"))),
    }
}

/// Delete the auth token from the OS keychain.
pub fn delete_token() -> Result<(), HkError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| HkError::Internal(format!("Keyring init failed: {e}")))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(HkError::Internal(format!("Failed to delete token: {e}"))),
    }
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------

/// Build the authenticated URL by embedding the token into the HTTPS URL.
/// e.g. https://github.com/user/repo → https://<token>@github.com/user/repo
fn authenticated_url(repo_url: &str, token: &str) -> String {
    if token.is_empty() {
        return repo_url.to_string();
    }
    if let Some(rest) = repo_url.strip_prefix("https://") {
        format!("https://{}@{}", token, rest)
    } else {
        repo_url.to_string()
    }
}

/// Clone or pull the sync repo into the local cache directory.
/// Returns the path to the local repo.
fn ensure_repo(
    cache_dir: &Path,
    repo_url: &str,
    branch: &str,
    token: &str,
) -> Result<PathBuf, HkError> {
    let repo_dir = cache_dir.join("sync-repo");
    let auth_url = authenticated_url(repo_url, token);

    if repo_dir.join(".git").exists() {
        // Pull latest
        let output = silent_command("git")
            .args(["fetch", "origin", branch])
            .current_dir(&repo_dir)
            .output()
            .map_err(|e| HkError::CommandFailed(format!("git fetch failed: {e}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(HkError::CommandFailed(format!(
                "git fetch failed: {}",
                stderr.trim()
            )));
        }
        // Reset to remote branch
        let output = silent_command("git")
            .args(["reset", "--hard", &format!("origin/{}", branch)])
            .current_dir(&repo_dir)
            .output()
            .map_err(|e| HkError::CommandFailed(format!("git reset failed: {e}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(HkError::CommandFailed(format!(
                "git reset failed: {}",
                stderr.trim()
            )));
        }
    } else {
        // Fresh clone
        if repo_dir.exists() {
            std::fs::remove_dir_all(&repo_dir)?;
        }
        let output = silent_command("git")
            .args([
                "clone",
                "--branch",
                branch,
                "--single-branch",
                "--depth",
                "1",
                "--",
                &auth_url,
                &repo_dir.to_string_lossy(),
            ])
            .output()
            .map_err(|e| HkError::CommandFailed(format!("git clone failed: {e}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(HkError::CommandFailed(format!(
                "git clone failed: {}",
                stderr.trim()
            )));
        }
    }
    Ok(repo_dir)
}

/// Commit and push all changes in the repo.
fn commit_and_push(
    repo_dir: &Path,
    branch: &str,
    message: &str,
    token: &str,
    repo_url: &str,
) -> Result<Option<String>, HkError> {
    // Stage all
    let output = silent_command("git")
        .args(["add", "-A"])
        .current_dir(repo_dir)
        .output()
        .map_err(|e| HkError::CommandFailed(format!("git add failed: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(HkError::CommandFailed(format!(
            "git add failed: {}",
            stderr.trim()
        )));
    }

    // Check if there's anything to commit
    let status = silent_command("git")
        .args(["status", "--porcelain"])
        .current_dir(repo_dir)
        .output()
        .map_err(|e| HkError::CommandFailed(format!("git status failed: {e}")))?;
    let status_text = String::from_utf8_lossy(&status.stdout);
    if status_text.trim().is_empty() {
        return Ok(None); // Nothing to commit
    }

    // Commit
    let output = silent_command("git")
        .args(["commit", "-m", message])
        .current_dir(repo_dir)
        .output()
        .map_err(|e| HkError::CommandFailed(format!("git commit failed: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(HkError::CommandFailed(format!(
            "git commit failed: {}",
            stderr.trim()
        )));
    }

    // Push
    let auth_url = authenticated_url(repo_url, token);
    let output = silent_command("git")
        .args(["push", &auth_url, branch])
        .current_dir(repo_dir)
        .output()
        .map_err(|e| HkError::CommandFailed(format!("git push failed: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(HkError::CommandFailed(format!(
            "git push failed: {}",
            stderr.trim()
        )));
    }

    // Get commit hash
    let hash_output = silent_command("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    Ok(hash_output)
}

// ---------------------------------------------------------------------------
// Push: local → Git
// ---------------------------------------------------------------------------

/// Push local skills, MCP configs, and hooks to the remote Git repo.
pub fn push(
    config: &SyncConfig,
    adapters: &[Box<dyn AgentAdapter>],
    data_dir: &Path,
) -> Result<SyncSummary, HkError> {
    let token = get_token()?.unwrap_or_default();
    let repo_dir = ensure_repo(data_dir, &config.repo_url, &config.branch, &token)?;

    let mut skills_count = 0;
    let mut mcp_count = 0;
    let mut hooks_count = 0;

    for adapter in adapters.iter().filter(|a| a.detect()) {
        let agent_name = adapter.name();

        // Skills
        if config.sync_skills {
            let target = repo_dir.join("skills").join(agent_name);
            // Clear and re-copy
            if target.exists() {
                std::fs::remove_dir_all(&target)?;
            }
            for skill_dir in adapter.skill_dirs() {
                if !skill_dir.exists() {
                    continue;
                }
                let entries = std::fs::read_dir(&skill_dir)?;
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir()
                        && (path.join("SKILL.md").exists()
                            || path.join("SKILL.md.disabled").exists())
                    {
                        let dest = target.join(path.file_name().unwrap());
                        copy_dir_recursive(&path, &dest)?;
                        skills_count += 1;
                    } else if path.extension().is_some_and(|e| e == "md") {
                        std::fs::create_dir_all(&target)?;
                        std::fs::copy(&path, target.join(path.file_name().unwrap()))?;
                        skills_count += 1;
                    }
                }
            }
        }

        // MCP config
        if config.sync_mcp {
            let mcp_path = adapter.mcp_config_path();
            if mcp_path.exists() {
                let target_dir = repo_dir.join("mcp");
                std::fs::create_dir_all(&target_dir)?;
                let ext = mcp_path
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let target_file = target_dir.join(format!("{}.{}", agent_name, ext));
                std::fs::copy(&mcp_path, &target_file)?;
                mcp_count += 1;
            }
        }

        // Hooks config
        if config.sync_hooks {
            let hook_path = adapter.hook_config_path();
            if hook_path.exists() {
                let target_dir = repo_dir.join("hooks");
                std::fs::create_dir_all(&target_dir)?;
                let ext = hook_path
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let target_file = target_dir.join(format!("{}.{}", agent_name, ext));
                std::fs::copy(&hook_path, &target_file)?;
                hooks_count += 1;
            }
        }
    }

    // Write a manifest
    let manifest = serde_json::json!({
        "version": 1,
        "synced_at": chrono::Utc::now().to_rfc3339(),
        "hostname": hostname(),
    });
    std::fs::write(
        repo_dir.join(".harnesskit-sync.json"),
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    )?;

    // Commit and push
    let hostname = hostname();
    let message = format!(
        "sync: push from {} at {}",
        hostname,
        chrono::Utc::now().format("%Y-%m-%d %H:%M")
    );
    let commit_hash = commit_and_push(
        &repo_dir,
        &config.branch,
        &message,
        &token,
        &config.repo_url,
    )?;

    let summary = SyncSummary {
        direction: "push".into(),
        skills_count,
        mcp_files_count: mcp_count,
        hook_files_count: hooks_count,
        commit_hash,
        message: format!(
            "Pushed {} skills, {} MCP configs, {} hook configs",
            skills_count, mcp_count, hooks_count
        ),
    };
    Ok(summary)
}

// ---------------------------------------------------------------------------
// Pull: Git → local
// ---------------------------------------------------------------------------

/// Pull skills, MCP configs, and hooks from the remote Git repo to local.
pub fn pull(
    config: &SyncConfig,
    adapters: &[Box<dyn AgentAdapter>],
    data_dir: &Path,
) -> Result<SyncSummary, HkError> {
    let token = get_token()?.unwrap_or_default();
    let repo_dir = ensure_repo(data_dir, &config.repo_url, &config.branch, &token)?;

    let mut skills_count = 0;
    let mut mcp_count = 0;
    let mut hooks_count = 0;

    // For pull, we install to the shared ~/.agents/skills/ directory (first detected adapter's
    // first skill_dir) so all agents can see them. For MCP/Hooks we write to each agent's
    // specific config path.
    let skills_repo_dir = repo_dir.join("skills");
    let mcp_repo_dir = repo_dir.join("mcp");
    let hooks_repo_dir = repo_dir.join("hooks");

    for adapter in adapters.iter().filter(|a| a.detect()) {
        let agent_name = adapter.name();

        // Pull skills
        if config.sync_skills {
            let agent_skills_in_repo = skills_repo_dir.join(agent_name);
            if agent_skills_in_repo.exists() && agent_skills_in_repo.is_dir() {
                // Install to the first skill dir of this agent
                let target_dir = adapter.skill_dirs().into_iter().next();
                if let Some(target_dir) = target_dir {
                    std::fs::create_dir_all(&target_dir)?;
                    let entries = std::fs::read_dir(&agent_skills_in_repo)?;
                    for entry in entries.flatten() {
                        let src = entry.path();
                        let dest = target_dir.join(src.file_name().unwrap());
                        if src.is_dir() {
                            copy_dir_recursive(&src, &dest)?;
                            skills_count += 1;
                        } else if src.extension().is_some_and(|e| e == "md") {
                            std::fs::copy(&src, &dest)?;
                            skills_count += 1;
                        }
                    }
                }
            }
        }

        // Pull MCP config
        if config.sync_mcp {
            let mcp_target = adapter.mcp_config_path();
            let ext = mcp_target
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let mcp_source = mcp_repo_dir.join(format!("{}.{}", agent_name, ext));
            if mcp_source.exists() {
                // Ensure parent dir exists
                if let Some(parent) = mcp_target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(&mcp_source, &mcp_target)?;
                mcp_count += 1;
            }
        }

        // Pull Hooks config
        if config.sync_hooks {
            let hook_target = adapter.hook_config_path();
            let ext = hook_target
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let hook_source = hooks_repo_dir.join(format!("{}.{}", agent_name, ext));
            if hook_source.exists() {
                if let Some(parent) = hook_target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(&hook_source, &hook_target)?;
                hooks_count += 1;
            }
        }
    }

    let summary = SyncSummary {
        direction: "pull".into(),
        skills_count,
        mcp_files_count: mcp_count,
        hook_files_count: hooks_count,
        commit_hash: None,
        message: format!(
            "Pulled {} skills, {} MCP configs, {} hook configs",
            skills_count, mcp_count, hooks_count
        ),
    };
    Ok(summary)
}

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

/// Test that the repo URL + token can be accessed.
pub fn test_connection(repo_url: &str, token: &str) -> Result<String, HkError> {
    let auth_url = authenticated_url(repo_url, token);
    let output = silent_command("git")
        .args(["ls-remote", "--heads", "--", &auth_url])
        .output()
        .map_err(|e| HkError::CommandFailed(format!("git ls-remote failed: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(HkError::CommandFailed(format!(
            "Connection failed: {}",
            stderr.trim()
        )));
    }
    Ok("Connection successful".into())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Recursively copy a directory.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), HkError> {
    std::fs::create_dir_all(dst)?;
    for entry in walkdir::WalkDir::new(src).min_depth(1) {
        let entry = entry.map_err(|e| HkError::Internal(format!("walkdir error: {e}")))?;
        let relative = entry
            .path()
            .strip_prefix(src)
            .map_err(|e| HkError::Internal(format!("strip_prefix error: {e}")))?;
        let target = dst.join(relative);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Get the machine hostname for commit messages.
fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into())
}
