export function buildSnapshotStyles(flags: { isCritical: boolean; isWarning: boolean }): string {
  const { isCritical, isWarning } = flags;
  const dotColor = isCritical ? "var(--danger)" : isWarning ? "var(--warning)" : "var(--success)";
  const bannerBg = isCritical
    ? "rgba(239, 68, 68, 0.12)"
    : isWarning
      ? "rgba(245, 158, 11, 0.12)"
      : "rgba(16, 185, 129, 0.12)";
  const bannerBorder = isCritical
    ? "rgba(239, 68, 68, 0.35)"
    : isWarning
      ? "rgba(245, 158, 11, 0.35)"
      : "rgba(16, 185, 129, 0.35)";
  const bannerColor = isCritical ? "#f87171" : isWarning ? "#fbbf24" : "#34d399";

  return `
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f293d;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-glow: rgba(56, 189, 248, 0.15);
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body {
      background-color: var(--bg);
      color: var(--text-main);
      padding: 16px 12px 48px;
      line-height: 1.4;
      max-width: 680px;
      margin: 0 auto;
    }
    .header {
      padding: 16px 8px 18px;
      text-align: left;
    }
    .badge-top {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(56, 189, 248, 0.12);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.25);
      margin-bottom: 8px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      background-color: ${dotColor};
      border-radius: 50%;
      box-shadow: 0 0 8px ${dotColor};
    }
    h1 {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: #ffffff;
      margin-bottom: 4px;
    }
    .timestamp {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .timestamp code {
      background: #1e293b;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      color: #cbd5e1;
    }
    .status-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: ${bannerBg};
      border: 1px solid ${bannerBorder};
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 16px;
    }
    .status-banner span {
      font-size: 13px;
      font-weight: 700;
      color: ${bannerColor};
    }
    .section-title {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #94a3b8;
      margin: 22px 4px 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    .grid-4 {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
    }
    @media (min-width: 480px) {
      .grid-4 {
        grid-template-columns: repeat(4, 1fr);
      }
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      padding: 14px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    }
    .card-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .card-val {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: #ffffff;
    }
    .card-sub {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .progress-bar-bg {
      width: 100%;
      height: 6px;
      background: #1e293b;
      border-radius: 999px;
      margin-top: 8px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      border-radius: 999px;
    }
    .dept-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .dept-name {
      font-size: 13px;
      font-weight: 600;
      color: #f1f5f9;
    }
    .dept-badges {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .badge {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 6px;
    }
    .badge-active {
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .badge-queue {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .badge-clean {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .workflow-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      font-size: 12px;
    }
    .btn-group {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 24px;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 12px 16px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary {
      background: #0284c7;
      color: #ffffff;
      border: none;
    }
    .btn-primary:active {
      background: #0369a1;
      transform: scale(0.98);
    }
    .btn-secondary {
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid #334155;
    }
    .btn-secondary:active {
      background: #334155;
    }
    .footer-note {
      text-align: center;
      font-size: 11px;
      color: #64748b;
      margin-top: 24px;
    }`;
}
