//! Adapter isolating all `tokscale-core` usage.
//!
//! Mirrors `tokscale` TUI's `DataLoader::aggregate_messages` (`crates/tokscale-cli/src/tui/data/mod.rs`)
//! 1-for-1 so that models, daily totals, sessions, and projects match the
//! `tokscale` TUI exactly without modifying `tokscale`'s data semantics.

use chrono::{Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use tokscale_core::pricing::PricingService;

// ---------------------------------------------------------------------------
// DTOs (serialized to the frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TokenBreakdownDTO {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cache_write_1h: i64,
    pub reasoning: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnifiedRowDTO {
    pub client: String,
    pub model: String,
    pub provider: String,
    pub session_id: String,
    pub workspace_key: Option<String>,
    pub workspace_label: Option<String>,
    pub session_title: Option<String>,
    pub agent: Option<String>,
    pub timestamp: i64,
    pub date: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub reasoning: i64,
    pub cost: f64,
    pub message_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DailyDTO {
    pub date: String,
    pub tokens: i64,
    pub cost: f64,
    pub messages: i32,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelRowDTO {
    pub model: String,
    pub provider: String,
    pub client: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub reasoning: i64,
    pub tokens: i64,
    pub cost: f64,
    pub messages: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionRowDTO {
    pub session_id: String,
    pub client: String,
    pub model: String,
    pub models: Vec<String>,
    pub session_title: Option<String>,
    pub workspace_key: Option<String>,
    pub workspace_label: Option<String>,
    pub agent: Option<String>,
    pub tokens: i64,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub reasoning: i64,
    pub cost: f64,
    pub messages: i32,
    pub first_seen: i64,
    pub last_seen: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectRowDTO {
    pub workspace_key: String,
    pub workspace_label: String,
    pub tokens: i64,
    pub cost: f64,
    pub messages: i32,
    pub sessions: i32,
    pub last_seen: i64,
    pub clients: Vec<String>,
    pub top_model: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct UsageSnapshotDTO {
    pub rows: Vec<UnifiedRowDTO>,
    pub daily: Vec<DailyDTO>,
    pub models: Vec<ModelRowDTO>,
    pub sessions: Vec<SessionRowDTO>,
    pub projects: Vec<ProjectRowDTO>,
    pub total_tokens: i64,
    pub total_cost: f64,
    pub total_messages: i32,
    pub clients: Vec<String>,
}

// ---------------------------------------------------------------------------
// Tokscale settings.json loader (matches crates/tokscale-cli/src/tui/settings.rs)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialTokscaleSettings {
    #[serde(default)]
    scanner: tokscale_core::scanner::ScannerSettings,
    #[serde(default)]
    model_aliases: tokscale_core::ModelAliasMap,
}

fn load_user_tokscale_settings() -> (tokscale_core::scanner::ScannerSettings, tokscale_core::ModelAliasMap) {
    let config_path = tokscale_core::paths::get_config_dir().join("settings.json");
    if let Ok(raw) = std::fs::read_to_string(&config_path) {
        if let Ok(parsed) = serde_json::from_str::<PartialTokscaleSettings>(&raw) {
            return (parsed.scanner, parsed.model_aliases);
        }
    }
    (
        tokscale_core::scanner::ScannerSettings::default(),
        tokscale_core::ModelAliasMap::default(),
    )
}

// ---------------------------------------------------------------------------
// Parsing entry point
// ---------------------------------------------------------------------------

/// Scan local agent clients via `tokscale-core` and aggregate using `tokscale`
/// TUI's exact rules (`GroupBy::Model`, `model_name_for_grouping`,
/// `workspace_bucket` with `WorktreeRollup::MergeIntoRepo`).
///
/// Pricing note: cost estimation is delegated to `tokscale-core`, which loads
/// public pricing catalogs (LiteLLM, OpenRouter, models.dev) and caches them on
/// disk for 1 hour (`pricing::cache::CACHE_TTL_SECS = 3600`), falling back to
/// the stale cache offline. While the app stays open, `lib.rs` refreshes the
/// catalog every 3 hours in a short-lived helper process and swaps the rebuilt
/// service in here. Those are catalog-only requests: no rows, token counts,
/// costs, model usage, session titles, workspace names, or paths from this scan
/// are included.
pub async fn parse_to_snapshot_async(
    home: Option<String>,
    clients: Option<Vec<String>>,
    since: Option<String>,
    until: Option<String>,
    pricing: Option<Arc<PricingService>>,
) -> Result<UsageSnapshotDTO, String> {
    let (scanner_settings, model_aliases) = if home.is_none() {
        load_user_tokscale_settings()
    } else {
        (
            tokscale_core::scanner::ScannerSettings::default(),
            tokscale_core::ModelAliasMap::default(),
        )
    };
    tokscale_core::model_alias::set_global(&model_aliases);

    // Match tokscale TUI's default client set (`ClientFilter::default_set()`):
    // every real ClientId, excluding "synthetic" unless explicitly requested.
    let effective_clients = match clients {
        Some(ref c) if !c.is_empty() => Some(c.clone()),
        _ => Some(
            tokscale_core::ClientId::iter()
                .map(|client| client.as_str().to_string())
                .collect(),
        ),
    };

    let options = tokscale_core::LocalParseOptions {
        home_dir: home,
        use_env_roots: true,
        clients: effective_clients,
        since: since.clone(),
        until: until.clone(),
        year: None,
        scanner_settings,
    };

    // Callers pass the current in-session pricing service so a refreshed
    // catalog takes effect without restarting. `None` preserves the old
    // behavior (initialize the process-global service) as a fallback.
    let unified = match pricing {
        Some(service) => {
            tokscale_core::parse_local_unified_messages_with_pricing(
                options,
                Some(service.as_ref()),
            )
            .await?
        }
        None => tokscale_core::parse_local_unified_messages(options).await?,
    };
    Ok(aggregate_unified_messages(&unified, since.as_deref(), until.as_deref()))
}

fn breakdown_total(input: i64, output: i64, cache_read: i64, cache_write: i64, reasoning: i64) -> i64 {
    input
        .max(0)
        .saturating_add(output.max(0))
        .saturating_add(cache_read.max(0))
        .saturating_add(cache_write.max(0))
        .saturating_add(reasoning.max(0))
}

fn parse_date(date_str: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(date_str, "%Y-%m-%d").ok()
}

/// Exact port of `message_timestamp_ms` from `crates/tokscale-cli/src/tui/data/mod.rs`.
fn message_timestamp_ms(timestamp: i64, date: &str) -> i64 {
    if timestamp > 0 {
        return timestamp;
    }
    parse_date(date)
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|dt| match Local.from_local_datetime(&dt) {
            chrono::LocalResult::Single(local) => local.timestamp_millis(),
            chrono::LocalResult::Ambiguous(earliest, _) => earliest.timestamp_millis(),
            chrono::LocalResult::None => dt.and_utc().timestamp_millis(),
        })
        .unwrap_or(0)
}

fn normalize_agent_for_client(client: &str, agent: &str) -> String {
    if client == "opencode" {
        tokscale_core::sessions::normalize_opencode_agent_name(agent)
    } else if client == "copilot" {
        tokscale_core::sessions::normalize_copilot_agent_name(agent)
    } else {
        tokscale_core::sessions::normalize_agent_name(agent)
    }
}

/// Aggregate `UnifiedMessage`s using `tokscale` TUI's exact rules.
fn aggregate_unified_messages(
    unified: &[tokscale_core::UnifiedMessage],
    since: Option<&str>,
    until: Option<&str>,
) -> UsageSnapshotDTO {
    // Pre-compute workspace label overrides using tokscale-core's native helper,
    // matching `crates/tokscale-cli/src/tui/data/mod.rs`.
    let mut workspace_labeler = tokscale_core::WorkspaceLabeler::default();
    let projects_label_overrides = tokscale_core::workspace_label_overrides(
        unified.iter(),
        tokscale_core::WorktreeRollup::MergeIntoRepo,
        &mut workspace_labeler,
    );

    let mut rows: Vec<UnifiedRowDTO> = Vec::with_capacity(unified.len());
    for m in unified {
        if let Some(s) = since {
            if m.date.as_str() < s {
                continue;
            }
        }
        if let Some(u) = until {
            if m.date.as_str() > u {
                continue;
            }
        }
        let normalized_model =
            tokscale_core::model_name_for_grouping(&m.client, &m.provider_id, &m.model_id);
        let (project_group_key, project_key, project_label) = tokscale_core::workspace_bucket(
            m,
            tokscale_core::WorktreeRollup::MergeIntoRepo,
            &mut workspace_labeler,
        );
        let resolved_label = projects_label_overrides
            .get(&project_group_key)
            .cloned()
            .unwrap_or(project_label);
        let norm_agent = m
            .agent
            .as_deref()
            .map(|a| normalize_agent_for_client(&m.client, a))
            .filter(|a| !a.trim().is_empty());

        rows.push(UnifiedRowDTO {
            client: m.client.clone(),
            model: normalized_model,
            provider: m.provider_id.clone(),
            session_id: m.session_id.clone(),
            workspace_key: project_key.or_else(|| m.workspace_key.clone()),
            workspace_label: Some(resolved_label),
            session_title: m.session_title.clone(),
            agent: norm_agent,
            timestamp: m.timestamp,
            date: m.date.clone(),
            input: m.tokens.input.max(0),
            output: m.tokens.output.max(0),
            cache_read: m.tokens.cache_read.max(0),
            cache_write: m.tokens.cache_write.max(0),
            reasoning: m.tokens.reasoning.max(0),
            cost: if m.cost.is_finite() && m.cost >= 0.0 {
                m.cost
            } else {
                0.0
            },
            message_count: m.message_count.max(0),
        });
    }

    build_snapshot_from_rows(rows, Some(unified))
}

/// Public entry for unit tests that construct `UnifiedRowDTO` directly.
#[allow(dead_code)]
pub fn build_snapshot(rows: Vec<UnifiedRowDTO>) -> UsageSnapshotDTO {
    // Normalize any raw rows passed by unit tests.
    let normalized_rows: Vec<UnifiedRowDTO> = rows
        .into_iter()
        .map(|mut r| {
            r.model = tokscale_core::model_name_for_grouping(&r.client, &r.provider, &r.model);
            r.input = r.input.max(0);
            r.output = r.output.max(0);
            r.cache_read = r.cache_read.max(0);
            r.cache_write = r.cache_write.max(0);
            r.reasoning = r.reasoning.max(0);
            if !r.cost.is_finite() || r.cost < 0.0 {
                r.cost = 0.0;
            }
            r
        })
        .collect();
    build_snapshot_from_rows(normalized_rows, None)
}

struct DayAcc {
    tokens: i64,
    cost: f64,
    messages: i32,
    input: i64,
    output: i64,
    cache_read: i64,
}

struct ModelAcc {
    model: String,
    provider: String,
    client: String,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    reasoning: i64,
    cost: f64,
    messages: i32,
}

struct SessionAcc {
    session_id: String,
    client: String,
    title: Option<String>,
    workspace_key: Option<String>,
    workspace_label: Option<String>,
    agents: Vec<String>,
    models: Vec<String>,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_write: i64,
    reasoning: i64,
    cost: f64,
    messages: i32,
    first_seen: i64,
    last_seen: i64,
}

struct ProjectAcc {
    workspace_key: String,
    label: String,
    clients: Vec<String>,
    models: Vec<String>,
    model_tokens: BTreeMap<String, i64>,
    tokens: i64,
    cost: f64,
    messages: i32,
    sessions: HashSet<String>,
    last_seen: i64,
}

fn build_snapshot_from_rows(
    rows: Vec<UnifiedRowDTO>,
    unified_source: Option<&[tokscale_core::UnifiedMessage]>,
) -> UsageSnapshotDTO {
    // 1. Models aggregation: matches tokscale TUI's `TUI_DEFAULT_GROUP_BY = GroupBy::Model`
    // (`crates/tokscale-cli/src/tui/cache.rs:60` and `data/mod.rs:930-1008`).
    let mut model_map: HashMap<String, ModelAcc> = HashMap::new();
    let mut daily_map: BTreeMap<String, DayAcc> = BTreeMap::new();
    let mut session_map: HashMap<String, SessionAcc> = HashMap::new();
    let mut project_map: HashMap<String, ProjectAcc> = HashMap::new();
    let mut client_last_seen: BTreeMap<String, i64> = BTreeMap::new();
    let mut total_messages: i32 = 0;

    for (idx, r) in rows.iter().enumerate() {
        let is_recovery_floor = unified_source
            .and_then(|u| u.get(idx))
            .is_some_and(tokscale_core::recovery::is_daily);
        let is_undated_balance = unified_source
            .and_then(|u| u.get(idx))
            .is_some_and(tokscale_core::claude_desktop::is_undated_balance);

        let tokens = breakdown_total(r.input, r.output, r.cache_read, r.cache_write, r.reasoning);
        let msg_cost = if r.cost.is_finite() && r.cost >= 0.0 {
            r.cost
        } else {
            0.0
        };
        total_messages = total_messages.saturating_add(r.message_count.max(0));

        let ts = message_timestamp_ms(r.timestamp, &r.date);
        {
            let e = client_last_seen.entry(r.client.clone()).or_insert(0);
            if ts > *e {
                *e = ts;
            }
        }

        // Model entry (GroupBy::ClientModel: key = client:normalized_model, merge providers)
        {
            let key = format!("{}:{}", r.client, r.model);
            let entry = model_map.entry(key).or_insert_with(|| ModelAcc {
                model: r.model.clone(),
                provider: r.provider.clone(),
                client: r.client.clone(),
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                reasoning: 0,
                cost: 0.0,
                messages: 0,
            });
            if !entry.provider.split(", ").any(|p| p == r.provider) {
                entry.provider = format!("{}, {}", entry.provider, r.provider);
            }
            entry.input = entry.input.saturating_add(r.input);
            entry.output = entry.output.saturating_add(r.output);
            entry.cache_read = entry.cache_read.saturating_add(r.cache_read);
            entry.cache_write = entry.cache_write.saturating_add(r.cache_write);
            entry.reasoning = entry.reasoning.saturating_add(r.reasoning);
            entry.cost += msg_cost;
            entry.messages = entry.messages.saturating_add(r.message_count.max(0));
        }

        // Daily entry (matches tokscale TUI `parse_date(&msg.date)`)
        if !is_undated_balance && parse_date(&r.date).is_some() {
            let d = daily_map.entry(r.date.clone()).or_insert(DayAcc {
                tokens: 0,
                cost: 0.0,
                messages: 0,
                input: 0,
                output: 0,
                cache_read: 0,
            });
            d.tokens = d.tokens.saturating_add(tokens);
            d.cost += msg_cost;
            d.messages = d.messages.saturating_add(r.message_count.max(0));
            d.input = d.input.saturating_add(r.input);
            d.output = d.output.saturating_add(r.output);
            d.cache_read = d.cache_read.saturating_add(r.cache_read);
        }

        // Session entry (matches tokscale TUI `if !is_recovery_floor && !msg.session_id.is_empty()`)
        if !is_recovery_floor && !r.session_id.is_empty() {
            let session_key = format!("{}:{}", r.client, r.session_id);
            let s = session_map.entry(session_key).or_insert_with(|| SessionAcc {
                session_id: r.session_id.clone(),
                client: r.client.clone(),
                title: None,
                workspace_key: None,
                workspace_label: None,
                agents: Vec::new(),
                models: Vec::new(),
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                reasoning: 0,
                cost: 0.0,
                messages: 0,
                first_seen: 0,
                last_seen: 0,
            });
            s.input = s.input.saturating_add(r.input);
            s.output = s.output.saturating_add(r.output);
            s.cache_read = s.cache_read.saturating_add(r.cache_read);
            s.cache_write = s.cache_write.saturating_add(r.cache_write);
            s.reasoning = s.reasoning.saturating_add(r.reasoning);
            s.cost += msg_cost;
            s.messages = s.messages.saturating_add(r.message_count.max(0));

            if ts > 0 {
                if s.first_seen == 0 || ts < s.first_seen {
                    s.first_seen = ts;
                }
                if ts > s.last_seen {
                    s.last_seen = ts;
                }
            }
            if let Some(ref title) = r.session_title {
                let trimmed = title.trim();
                if !trimmed.is_empty() {
                    s.title = Some(trimmed.to_string());
                }
            }
            if let Some(ref wk) = r.workspace_key {
                let trimmed = wk.trim();
                if !trimmed.is_empty() {
                    s.workspace_key = Some(trimmed.to_string());
                }
            }
            if let Some(ref wl) = r.workspace_label {
                let trimmed = wl.trim();
                if !trimmed.is_empty() && trimmed != "Unknown workspace" {
                    s.workspace_label = Some(trimmed.to_string());
                }
            }
            if let Some(ref agent) = r.agent {
                let trimmed = agent.trim();
                if !trimmed.is_empty() && !s.agents.iter().any(|a| a == trimmed) {
                    s.agents.push(trimmed.to_string());
                }
            }
            if !s.models.iter().any(|m| m == &r.model) {
                s.models.push(r.model.clone());
            }
        }

        // Project entry (matches tokscale TUI `project_map`)
        {
            let wk = r
                .workspace_key
                .clone()
                .unwrap_or_else(|| "(unknown)".to_string());
            let wl = r
                .workspace_label
                .clone()
                .unwrap_or_else(|| "Unknown workspace".to_string());
            let p = project_map.entry(wk.clone()).or_insert_with(|| ProjectAcc {
                workspace_key: wk.clone(),
                label: wl.clone(),
                clients: Vec::new(),
                models: Vec::new(),
                model_tokens: BTreeMap::new(),
                tokens: 0,
                cost: 0.0,
                messages: 0,
                sessions: HashSet::new(),
                last_seen: 0,
            });
            p.tokens = p.tokens.saturating_add(tokens);
            p.cost += msg_cost;
            p.messages = p.messages.saturating_add(r.message_count.max(0));
            if ts > p.last_seen {
                p.last_seen = ts;
            }
            if !p.clients.iter().any(|c| c == &r.client) {
                p.clients.push(r.client.clone());
            }
            if !p.models.iter().any(|m| m == &r.model) {
                p.models.push(r.model.clone());
            }
            *p.model_tokens.entry(r.model.clone()).or_insert(0) = p
                .model_tokens
                .get(&r.model)
                .copied()
                .unwrap_or(0)
                .saturating_add(tokens);
            if !is_recovery_floor && !r.session_id.is_empty() {
                p.sessions.insert(format!("{}:{}", r.client, r.session_id));
            }
        }
    }

    // Sort models identically to tokscale TUI (`data/mod.rs:1587-1592`)
    let mut models: Vec<ModelRowDTO> = model_map
        .into_values()
        .map(|m| {
            let tokens = breakdown_total(m.input, m.output, m.cache_read, m.cache_write, m.reasoning);
            ModelRowDTO {
                model: m.model,
                provider: m.provider,
                client: m.client,
                input: m.input,
                output: m.output,
                cache_read: m.cache_read,
                cache_write: m.cache_write,
                reasoning: m.reasoning,
                tokens,
                cost: m.cost,
                messages: m.messages,
            }
        })
        .collect();
    models.sort_by(|a, b| {
        b.cost
            .total_cmp(&a.cost)
            .then_with(|| a.model.cmp(&b.model))
            .then_with(|| a.provider.cmp(&b.provider))
    });

    // Total tokens & total cost: exact sum of `models` (matches `data/mod.rs:1707-1714`)
    let total_tokens: i64 = models
        .iter()
        .map(|m| m.tokens)
        .fold(0i64, i64::saturating_add);
    let total_cost: f64 = models
        .iter()
        .map(|m| if m.cost.is_finite() { m.cost } else { 0.0 })
        .sum();

    let daily: Vec<DailyDTO> = daily_map
        .into_iter()
        .map(|(date, d)| DailyDTO {
            date,
            tokens: d.tokens,
            cost: d.cost,
            messages: d.messages,
            input: d.input,
            output: d.output,
            cache_read: d.cache_read,
        })
        .collect();

    // Sessions: sorted by `last_seen DESC` (matches tokscale TUI `Tab::Sessions` default sort `SortField::Date, Descending`)
    let mut sessions: Vec<SessionRowDTO> = session_map
        .into_values()
        .map(|s| {
            let tokens = breakdown_total(s.input, s.output, s.cache_read, s.cache_write, s.reasoning);
            let primary_model = s
                .models
                .iter()
                .find(|m| !m.eq_ignore_ascii_case("unknown"))
                .or_else(|| s.models.first())
                .cloned()
                .unwrap_or_else(|| "unknown".to_string());
            let agent = if s.agents.is_empty() {
                None
            } else {
                Some(s.agents.join(", "))
            };
            SessionRowDTO {
                session_id: s.session_id,
                client: s.client,
                model: primary_model,
                models: s.models,
                session_title: s.title,
                workspace_key: s.workspace_key,
                workspace_label: s.workspace_label,
                agent,
                tokens,
                input: s.input,
                output: s.output,
                cache_read: s.cache_read,
                reasoning: s.reasoning,
                cost: s.cost,
                messages: s.messages,
                first_seen: s.first_seen,
                last_seen: s.last_seen,
            }
        })
        .collect();
    sessions.sort_by(|a, b| {
        b.last_seen
            .cmp(&a.last_seen)
            .then_with(|| a.client.cmp(&b.client))
            .then_with(|| a.session_id.cmp(&b.session_id))
    });

    // Projects: sorted identically to tokscale TUI (`data/mod.rs:1696-1702`)
    let mut projects: Vec<ProjectRowDTO> = project_map
        .into_values()
        .map(|p| {
            let top_model = p
                .model_tokens
                .iter()
                .max_by(|a, b| a.1.cmp(b.1))
                .map(|(k, _)| k.clone())
                .or_else(|| p.models.first().cloned())
                .unwrap_or_else(|| "unknown".to_string());
            ProjectRowDTO {
                workspace_key: p.workspace_key,
                workspace_label: p.label,
                tokens: p.tokens,
                cost: p.cost,
                messages: p.messages,
                sessions: p.sessions.len() as i32,
                last_seen: p.last_seen,
                clients: p.clients,
                top_model,
            }
        })
        .collect();
    projects.sort_by(|a, b| {
        b.cost
            .total_cmp(&a.cost)
            .then_with(|| b.last_seen.cmp(&a.last_seen))
            .then_with(|| a.workspace_label.cmp(&b.workspace_label))
            .then_with(|| a.workspace_key.cmp(&b.workspace_key))
    });

    let mut clients_ranked: Vec<(String, i64)> = client_last_seen.into_iter().collect();
    clients_ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let clients: Vec<String> = clients_ranked.into_iter().map(|(c, _)| c).collect();

    UsageSnapshotDTO {
        rows,
        daily,
        models,
        sessions,
        projects,
        total_tokens,
        total_cost,
        total_messages,
        clients,
    }
}

/// Sync wrapper for tests / non-async callers.
#[allow(dead_code)]
pub fn parse_to_snapshot(
    home: Option<String>,
    clients: Option<Vec<String>>,
    since: Option<String>,
    until: Option<String>,
) -> Result<UsageSnapshotDTO, String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;
    rt.block_on(parse_to_snapshot_async(
        home, clients, since, until, None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_snapshot_is_default() {
        let s = build_snapshot(vec![]);
        assert_eq!(s.total_tokens, 0);
        assert_eq!(s.total_cost, 0.0);
        assert!(s.rows.is_empty());
        assert!(s.models.is_empty());
        assert!(s.sessions.is_empty());
    }
}
