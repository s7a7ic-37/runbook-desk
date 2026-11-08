import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { stateLabel, timeLabel } from "./format";
import { caseReport } from "./report";
import type { Case, CaseSummary, Config } from "./types";
import publicRunbooks from "../../server/runbooks.json";

type View = "desk" | "library" | "history";

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [history, setHistory] = useState<CaseSummary[]>([]);
  const [historySearch, setHistorySearch] = useState("");
  const historySearchInput = useRef<HTMLInputElement>(null);
  const historyTerm = historySearch.trim().toLowerCase();
  const matchingHistory = history.filter(item => item.title.toLowerCase().includes(historyTerm));
  const [active, setActive] = useState<Case | null>(null);
  const [view, setView] = useState<View>("desk");
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const caseHeading = useRef<HTMLHeadingElement>(null);
  const focusLocation = useRef({view, id: active?.id});
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>(["rb-scope"]);
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("Starting your workspace");
  const [error, setError] = useState<string | Error>("");
  const [notice, setNotice] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const caseForm = useRef<HTMLFormElement>(null);
  const reviewForm = useRef<HTMLFormElement>(null);
  const pendingCreation = useRef<{ input: string; key: string } | null>(null);
  const changedCase = !active && (title.trim() !== "" || description.trim() !== "" || selected.length !== 1 || selected[0] !== "rb-scope");
  const changedReview = active?.state === "draft" && (reply !== active.reply || note.trim() !== "");

  async function refreshWorkspace() {
    const [settings, cases] = await Promise.all([
      api<Config>("/config"),
      api<CaseSummary[]>("/cases"),
    ]);
    setConfig(settings);
    setHistory(cases);
  }

  async function initialize() {
    await api("/workspace", "POST");
    await refreshWorkspace();
  }

  async function createCase(path: string, body?: unknown) {
    const input = JSON.stringify([path, body ?? null]);
    if (pendingCreation.current?.input !== input)
      pendingCreation.current = { input, key: crypto.randomUUID() };
    const attempt = pendingCreation.current;
    const record = await api<Case>(path, "POST", body, attempt.key);
    if (pendingCreation.current === attempt) pendingCreation.current = null;
    return record;
  }

  useEffect(() => {
    let cancelled = false;
    initialize()
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setBusy("");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Initialize together: a later effect can overwrite edits made after opening a case.
  function showCase(record: Case | null) {
    setActive(record);
    setReply(record?.reply || "");
    setNote("");
  }

  useEffect(() => {
    const id = active?.id;
    if (focusLocation.current.view === view && focusLocation.current.id === id) return;
    focusLocation.current = {view, id};
    (view === "desk" && id ? caseHeading.current : pageHeading.current)?.focus();
  }, [view, active?.id]);

  useEffect(() => {
    if (!changedCase && !changedReview) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changedCase, changedReview]);

  useEffect(() => {
    if (source && dialog.current && !dialog.current.open)
      dialog.current.showModal();
    if (!source && dialog.current?.open) dialog.current.close();
  }, [source]);

  async function perform(label: string, work: () => Promise<void>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error
          ? e
          : "Something went wrong. Please try again.",
      );
      if (e instanceof ApiError && e.status === 401)
        setNotice("Reload to start a new browser workspace.");
    } finally {
      setBusy("");
    }
  }

  function canLeave() {
    if (changedCase) {
      return window.confirm("Discard your unsaved case details?");
    }
    return (
      !changedReview ||
      window.confirm("Discard your unsaved review edits?")
    );
  }

  function newCase() {
    if (busy || !canLeave()) return;
    pendingCreation.current = null;
    showCase(null);
    setTitle("");
    setDescription("");
    setSelected(["rb-scope"]);
    setError("");
    setNotice("");
    setView("desk");
  }

  function pickRunbook(id: string) {
    if (selected.includes(id))
      setSelected(selected.filter((value) => value !== id));
    else if (selected.length < 3) setSelected([...selected, id]);
    else
      setError(
        "Choose at most three runbooks so the draft has a focused evidence base.",
      );
  }

  async function openCase(id: string) {
    if (!canLeave()) return;
    await perform("Opening saved case", async () => {
      const saved = await api<Case>("/cases/" + id);
      showCase(saved);
      setHistory(items => items.map(item => item.id === saved.id
        ? { ...item, state: saved.state, updated_at: saved.updated_at }
        : item));
      setView("desk");
    });
  }

  async function openExample(id: string) {
    if (!canLeave()) return;
    await perform("Opening worked example", async () => {
      showCase(await createCase("/examples/" + id));
      setView("desk");
      await refreshWorkspace();
    });
  }

  async function saveCase(generate = false) {
    if (!caseForm.current?.reportValidity()) return;
    if (!selected.length) {
      setError("Select at least one runbook.");
      return;
    }
    await perform(
      generate ? "Preparing an investigation draft" : "Saving your case",
      async () => {
        const created = await createCase("/cases", {
          title,
          description,
          runbook_ids: selected,
        });
        showCase(created);
        if (generate) {
          try {
            showCase(
              await api<Case>("/cases/" + created.id + "/generate", "POST"),
            );
          } catch (e) {
            showCase(await api<Case>("/cases/" + created.id));
            await refreshWorkspace();
            throw e;
          }
        }
        await refreshWorkspace();
      },
    );
  }

  async function generateDraft() {
    if (!active) return;
    const id = active.id;
    await perform("Preparing an investigation draft", async () => {
      try {
        showCase(await api<Case>("/cases/" + id + "/generate", "POST"));
      } catch (e) {
        showCase(await api<Case>("/cases/" + id));
        throw e;
      } finally {
        await refreshWorkspace();
      }
    });
  }

  async function review(decision: "approved" | "rejected") {
    if (!active || !reviewForm.current?.reportValidity()) return;
    await perform("Recording your review", async () => {
      showCase(
        await api<Case>("/cases/" + active.id + "/review", "POST", {
          version: active.version,
          decision,
          reply,
          note,
        }),
      );
      await refreshWorkspace();
      setNotice(
        decision === "approved"
          ? "Review recorded. The reply is ready to copy; nothing has been sent."
          : "Review recorded. This case needs further investigation.",
      );
    });
  }

  async function deleteActiveCase() {
    if (
      !active ||
      !window.confirm(
        "Delete this saved case and its review history? This cannot be undone, and unsaved edits will be lost.",
      )
    ) return;
    const id = active.id;
    await perform("Deleting saved case", async () => {
      await api<{ deleted: boolean }>("/cases/" + id, "DELETE");
      setHistory(items => items.filter(item => item.id !== id));
      pendingCreation.current = null;
      showCase(null);
      setTitle("");
      setDescription("");
      setSelected(["rb-scope"]);
      setView("history");
      setNotice("Saved case and review history deleted.");
    });
  }

  const bookName = (id: string) =>
    id === "incident"
      ? "Case details"
      : config?.runbooks.find((book) => book.id === id)?.title || id;
  const sourceBook = config?.runbooks.find((book) => book.id === source);
  const terminal = active?.state === "approved" || active?.state === "rejected";
  function downloadHandoff() {
    if (!active || !config) return;
    const url = URL.createObjectURL(new Blob([caseReport(active, config.runbooks)], {
      type: "text/plain;charset=utf-8",
    }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `runbook-case-${active.id.slice(0, 8)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice("Case handoff downloaded. It contains the recorded review and selected procedures.");
  }
  const citation = (id: string) => (
    <button
      type="button"
      className="citation"
      disabled={!!busy}
      key={id}
      onClick={() => setSource(id)}
    >
      {bookName(id)} <span aria-hidden="true">↗</span>
    </button>
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Runbook Desk home" onClick={event => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          newCase();
        }}>
          <img src="/favicon.svg" width="36" height="36" alt="" />
          <span>
            Runbook <strong>Desk</strong>
          </span>
        </a>
        <nav aria-label="Workspace navigation">
          {(["desk", "library", "history"] as View[]).map((item) => (
            <button
              key={item}
              aria-current={view === item ? "page" : undefined}
              onClick={() => setView(item)}
              disabled={!!busy && !!config}
            >
              {item === "desk"
                ? "Workspace"
                : item === "library"
                  ? "Runbooks"
                  : "History"}
            </button>
          ))}
        </nav>
        <span className={"connection " + (config?.live_enabled ? "live" : "")}>
          <i />
          {!config ? (busy ? "Connecting workspace" : "Workspace unavailable") : config.live_enabled ? "Live drafts available" : "Example mode"}
        </span>
      </header>

      <div className="layout">
        <aside className="sidebar" aria-label="Cases and examples">
          <button
            className="button primary new-case"
            onClick={newCase}
            disabled={!!busy || !config}
          >
            ＋ New case
          </button>
          <div className="side-section">
            <p className="section-label">Worked examples</p>
            <p className="side-note">Illustrative drafts. No model call.</p>
            {config?.examples.map((example, index) => (
              <button
                className="example-link"
                key={example.id}
                disabled={!!busy}
                onClick={() => openExample(example.id)}
              >
                <span className="index">0{index + 1}</span>
                <span>{example.title}</span>
                <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
          <div className="side-section">
            <p className="section-label">
              Recent cases <span>{config ? history.length : "—"}</span>
            </p>
            {!history.length && (
              <p className="side-note">
                {config ? "Saved cases appear here in this browser workspace." : "History will load when the case server connects."}
              </p>
            )}
            {history.slice(0, 5).map((item) => (
              <button
                className={
                  "recent-link " + (active?.id === item.id ? "selected" : "")
                }
                key={item.id}
                onClick={() => openCase(item.id)}
                disabled={!!busy}
              >
                <span>{item.title}</span>
                <small>
                  {stateLabel[item.state]} · {timeLabel(item.updated_at)}
                </small>
              </button>
            ))}
          </div>
          <div className="sidebar-bottom">
            <span className="small-mark">RD / 01</span>
            <p>
              From incident notes
              <br />
              to a considered response.
            </p>
          </div>
        </aside>

        <main id="main">
          <div className="mobile-actions">
            <button
              className="button primary"
              onClick={newCase}
              disabled={!!busy || !config}
            >
              ＋ New case
            </button>
            <label className="sr-only" htmlFor="mobile-example">
              Open a worked example
            </label>
            <select
              id="mobile-example"
              value=""
              disabled={!!busy || !config}
              onChange={(event) => {
                if (event.target.value) openExample(event.target.value);
              }}
            >
              <option value="">Worked examples</option>
              {config?.examples.map((example) => (
                <option key={example.id} value={example.id}>
                  {example.title}
                </option>
              ))}
            </select>
          </div>
          <div className="page-heading">
            <div>
              <p className="eyebrow">A support engineer’s workspace</p>
              <h1 ref={pageHeading} tabIndex={-1}>
                {view === "library"
                  ? "The runbook library."
                  : view === "history"
                    ? "Your case history."
                    : "A clear next step."}
              </h1>
              <p className="intro">
                {view === "library"
                  ? "The sources behind each suggestion. These are fictional procedures for this demo."
                  : view === "history"
                    ? "Reopen a case to see its original draft, review decision and saved reply."
                    : "Draft an investigation plan from the runbooks you choose, then review the customer reply."}
              </p>
            </div>
            <span className="page-number" aria-hidden="true">
              {view === "desk" ? "01" : view === "library" ? "02" : "03"}
            </span>
          </div>
          {error && (
            <div className="alert" role="alert">
              <strong>That didn’t complete.</strong> {error instanceof Error ? error.message : error}
              {error instanceof ApiError && error.status === 409 && active && (
                <button className="button quiet" disabled={!!busy} onClick={() => openCase(active.id)}>
                  Reload saved case
                </button>
              )}
              {!config && (
                <button
                  className="button quiet"
                  disabled={!!busy}
                  onClick={() => perform("Reconnecting", initialize)}
                >
                  Retry connection
                </button>
              )}
            </div>
          )}
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          {view === "library" ? (
            <>
            {!config && <p className="help">Read-only library. Saving and reviewing cases needs a connection to the case server.</p>}
            <div className="library-grid">
              {(config?.runbooks || publicRunbooks).map((book) => (
                <article className="runbook-card" key={book.id}>
                  <span className="tag">{book.category}</span>
                  <h2>{book.title}</h2>
                  <p>{book.body}</p>
                  <small>Demo procedure · reviewed {book.updated}</small>
                </article>
              ))}
            </div>
            </>
          ) : !config ? (
            <div className="loading-panel" role="status">
              {busy && <span className="spinner" />}
              {busy || "Workspace unavailable. Retry the connection to use saved cases."}
              <button className="button secondary" type="button" onClick={() => setView("library")}>Read runbooks</button>
            </div>
          ) : view === "history" ? (
            <section className="history-panel">
              <div className="panel-heading">
                <h2>Saved in your workspace</h2>
                <span className="muted">{history.length} / 20 cases</span>
                <button className="button secondary" type="button" disabled={!!busy}
                  onClick={() => perform("Refreshing history", refreshWorkspace)}>
                  {busy === "Refreshing history" ? "Refreshing history…" : "Refresh history"}
                </button>
              </div>
              {history.length ? (
                <>
                <div className="history-search">
                  <label className="field-label" htmlFor="history-search">Find a saved case</label>
                  <input ref={historySearchInput} id="history-search" type="search" value={historySearch}
                    onChange={(event) => setHistorySearch(event.target.value)} />
                  <p className="help" role="status">{matchingHistory.length} of {history.length} saved cases</p>
                </div>
                <div className="history-list">
                  {matchingHistory.map((item) => (
                    <button
                      className="history-row"
                      key={item.id}
                      onClick={() => openCase(item.id)}
                      disabled={!!busy}
                    >
                      <span>
                        <strong>{item.title}</strong>
                        <small>
                          {item.mode === "example"
                            ? "Worked example"
                            : "Your case"}{" "}
                          ·{" "}
                          <time
                            dateTime={item.updated_at}
                            title={new Date(item.updated_at).toLocaleString()}
                          >
                            {timeLabel(item.updated_at)}
                          </time>
                        </small>
                      </span>
                      <span className={"status " + item.state}>
                        {stateLabel[item.state]}
                      </span>
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                  {!matchingHistory.length && (
                    <div className="empty">
                      <p>No saved cases match this title.</p>
                      <button className="button secondary" type="button" onClick={() => {
                        setHistorySearch("");
                        historySearchInput.current?.focus();
                      }}>Clear search</button>
                    </div>
                  )}
                </div>
                </>
              ) : (
                <div className="empty">
                  <h3>Nothing saved yet.</h3>
                  <p>Start with an example to try the review workflow.</p>
                  <button
                    className="button primary"
                    onClick={() => openExample(config.examples[0].id)}
                  >
                    Open an example
                  </button>
                </div>
              )}
            </section>
          ) : (
            <div className="desk-grid">
              <section className="case-panel">
                <div className="panel-heading">
                  <h2>{active ? "Case brief" : "Start with the facts"}</h2>
                  <span className="step">01</span>
                </div>
                {active ? (
                  <div className="saved-brief">
                    <div className="brief-tags">
                      <span className={"status " + active.state}>
                        {stateLabel[active.state]}
                      </span>
                      {active.mode === "example" && (
                        <span className="tag">Illustrative example</span>
                      )}
                    </div>
                    <h3 ref={caseHeading} tabIndex={-1}>{active.title}</h3>
                    <p className="case-description">{active.description}</p>
                    <p className="section-label">Selected sources</p>
                    <div className="source-stack">
                      {active.runbook_ids.map(citation)}
                    </div>
                    <p className="small-meta">
                      Saved{" "}
                      {new Date(active.created_at).toLocaleString("en-GB")}
                    </p>
                    {["new", "failed", "generating"].includes(active.state) && (
                      <>
                        <button
                          className="button primary wide"
                          disabled={!!busy || !config.live_enabled}
                          onClick={generateDraft}
                        >
                          {active.state === "failed"
                            ? "Retry live draft"
                            : "Generate live draft"}
                        </button>
                        {!config.live_enabled && (
                          <p className="help">
                            Live generation is paused. You can still review a
                            worked example.
                          </p>
                        )}
                      </>
                    )}
                    {config.case_deletion_enabled === true && <button
                      className="button quiet"
                      type="button"
                      disabled={!!busy}
                      onClick={deleteActiveCase}
                    >
                      Delete saved case
                    </button>}
                  </div>
                ) : (
                  <form
                    ref={caseForm}
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveCase();
                    }}
                  >
                    <label className="field-label" htmlFor="case-title">
                      Case title
                    </label>
                    <input
                      id="case-title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      minLength={5}
                      maxLength={120}
                      placeholder="What is the customer experiencing?"
                      required
                      disabled={!!busy}
                    />
                    <label className="field-label" htmlFor="case-description">
                      Incident notes <span>{description.length}/5000</span>
                    </label>
                    <textarea
                      id="case-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      minLength={30}
                      maxLength={5000}
                      rows={7}
                      placeholder="Include the visible error, affected feature, timing and what is already known."
                      required
                      disabled={!!busy}
                    />
                    <p className="help">
                      Use fictional details. Generating a live draft sends the
                      case text and selected runbooks to OpenAI.
                    </p>
                    <fieldset disabled={!!busy}>
                      <legend>
                        Choose the relevant runbooks{" "}
                        <span>{selected.length}/3</span>
                      </legend>
                      {config.runbooks.map((book) => (
                        <div className="runbook-option" key={book.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={selected.includes(book.id)}
                              onChange={() => pickRunbook(book.id)}
                            />
                            <span>{book.title}</span>
                          </label>
                          <button
                            className="read-source"
                            type="button"
                            onClick={() => setSource(book.id)}
                            aria-label={"Read " + book.title}
                          >
                            Read
                          </button>
                        </div>
                      ))}
                    </fieldset>
                    <div className="form-actions">
                      <button
                        className="button primary"
                        type="submit"
                        disabled={!!busy}
                      >
                        Save case
                      </button>
                      <button
                        className="button secondary"
                        type="button"
                        disabled={!!busy || !config.live_enabled}
                        onClick={() => saveCase(true)}
                      >
                        Save and generate
                      </button>
                    </div>
                    {!config.live_enabled && (
                      <p className="paused-note">
                        <span className="pause-dot" /> Live calls are paused.
                        Open a worked example to explore a complete draft.
                      </p>
                    )}
                  </form>
                )}
              </section>

              <section className="draft-panel" aria-busy={!!busy}>
                <div className="panel-heading">
                  <h2>Investigation & review</h2>
                  <span className="step">02</span>
                </div>
                {busy && config ? (
                  <div
                    className="loading-panel"
                    role="status"
                    aria-live="polite"
                  >
                    <span className="spinner" />
                    <strong>{busy}</strong>
                    <span className="muted">
                      {busy.includes("draft")
                        ? "The draft will appear here when it is ready for your review."
                        : "Your workspace will update when this finishes."}
                    </span>
                    <div className="skeleton-lines" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                ) : active?.draft ? (
                  <div className="draft-content">
                    {active.mode === "example" && (
                      <div className="example-banner">
                        Worked example · This is an illustrative draft, not an
                        OpenAI response.
                      </div>
                    )}
                    <div className="draft-summary">
                      <span className={"priority " + active.draft.priority}>
                        {active.draft.priority} suggested priority
                      </span>
                      <h3>What we know</h3>
                      <p>{active.draft.summary}</p>
                    </div>
                    <div className="observations">
                      {active.draft.observations.map((observation, index) => (
                        <div key={index}>
                          <p>{observation.statement}</p>
                          {citation(observation.source_id)}
                        </div>
                      ))}
                    </div>
                    <h3 className="subheading">Proposed checks</h3>
                    <ol className="checks">
                      {active.draft.checks.map((check, index) => (
                        <li key={index}>
                          <span className="check-number">{index + 1}</span>
                          <div>
                            <strong>{check.action}</strong>
                            <p>{check.reason}</p>
                            <div className="check-sources">
                              {check.source_ids.map(citation)}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                    {!!active.draft.missing_information.length && (
                      <div className="questions">
                        <h3>Still to establish</h3>
                        <ul>
                          {active.draft.missing_information.map(
                            (question, index) => (
                              <li key={index}>{question}</li>
                            ),
                          )}
                        </ul>
                      </div>
                    )}
                    <form
                      ref={reviewForm}
                      className="review-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        review("approved");
                      }}
                    >
                      <div className="review-heading">
                        <h3>Customer reply</h3>
                        <span>
                          {terminal
                            ? "Review recorded"
                            : "Editable before approval"}
                        </span>
                      </div>
                      <label className="sr-only" htmlFor="customer-reply">
                        Review the customer reply
                      </label>
                      <textarea
                        id="customer-reply"
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        minLength={30}
                        maxLength={3000}
                        rows={8}
                        readOnly={!!terminal}
                        required
                        disabled={!!busy}
                      />
                      {!terminal ? (
                        <>
                          <label className="field-label" htmlFor="review-note">
                            Your review note
                          </label>
                          <textarea
                            id="review-note"
                            rows={2}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="What did you verify, edit or decide to investigate?"
                            minLength={3}
                            maxLength={500}
                            required
                            disabled={!!busy}
                          />
                          <div className="form-actions">
                            <button
                              className="button primary"
                              type="submit"
                              disabled={!!busy}
                            >
                              Approve reply
                            </button>
                            <button
                              className="button secondary"
                              type="button"
                              disabled={!!busy}
                              onClick={() => review("rejected")}
                            >
                              Needs investigation
                            </button>
                          </div>
                          <p className="help">
                            Approval records your decision. This app does not
                            send customer messages or execute the proposed
                            checks.
                          </p>
                        </>
                      ) : (
                        active.state === "approved" && (
                          <button
                            className="button primary"
                            type="button"
                            onClick={async () => {
                              setError("");
                              setNotice("");
                              try {
                                await navigator.clipboard.writeText(active.reply);
                                setNotice("Reviewed reply copied.");
                              } catch {
                                setError("Copy is unavailable here. Select the reply text to copy it manually.");
                              }
                            }}
                          >
                            Copy reviewed reply
                          </button>
                        )
                      )}
                    </form>
                    {!!active.reviews.length && (
                      <section className="review-trail">
                        <h3>Review trail</h3>
                        {terminal && (
                          <button className="button secondary" type="button" onClick={downloadHandoff}>
                            Download case handoff
                          </button>
                        )}
                        {active.reviews.map((entry, index) => (
                          <div key={index}>
                            <span className={"status " + entry.decision}>
                              {entry.decision === "approved"
                                ? "Approved"
                                : "Needs investigation"}
                            </span>
                            <time dateTime={entry.created_at}>
                              {new Date(entry.created_at).toLocaleString(
                                "en-GB",
                              )}
                            </time>
                            <p>{entry.note}</p>
                            {entry.original_reply !== entry.reviewed_reply && (
                              <small>
                                Reply edited before the decision. The original
                                draft is retained.
                              </small>
                            )}
                          </div>
                        ))}
                      </section>
                    )}
                    {!!active.runs.length && (
                      <details className="run-details">
                        <summary>Generation details</summary>
                        {active.runs.map((run, index) => (
                          <p key={index}>
                            {run.model} · {run.state}
                            {run.input_tokens !== null &&
                              ` · ${run.input_tokens} input / ${run.output_tokens} output tokens`}
                            {run.latency_ms !== null &&
                              ` · ${(run.latency_ms / 1000).toFixed(1)}s`}
                          </p>
                        ))}
                      </details>
                    )}
                  </div>
                ) : (
                  <div className="empty draft-empty">
                    <span className="empty-icon" aria-hidden="true">
                      ↳
                    </span>
                    <h3>
                      {active
                        ? "No draft generated yet."
                        : "A second view on the case."}
                    </h3>
                    <p>
                      {active
                        ? "Your notes are saved. A draft will only appear after a successful live generation or when you open a worked example."
                        : "An investigation draft brings the case facts and selected procedures together, with references you can check."}
                    </p>
                    <button
                      className="button secondary"
                      disabled={!!busy}
                      onClick={() => openExample(config.examples[0].id)}
                    >
                      Try a worked example <span aria-hidden="true">↗</span>
                    </button>
                    <span className="example-caption">
                      Fictional case · illustrated response · no API charge
                    </span>
                  </div>
                )}
              </section>
            </div>
          )}
          <footer>
            <a href="https://portfolio.artemislab.co.uk/#projects">
              ← All projects
            </a>
            <span>Runbook Desk</span>
            <a href="https://github.com/s7a7ic-37/runbook-desk">Source ↗</a>
          </footer>
        </main>
      </div>
      <dialog
        ref={dialog}
        className="source-dialog"
        aria-labelledby="source-title"
        onCancel={() => setSource(null)}
      >
        <div className="dialog-heading">
          <p className="section-label">
            {source === "incident" ? "Original report" : sourceBook?.category}
          </p>
          <button
            className="button quiet"
            onClick={() => setSource(null)}
            aria-label="Close source"
          >
            Close ×
          </button>
        </div>
        <h2 id="source-title">
          {source === "incident" ? "Case details" : sourceBook?.title}
        </h2>
        <p>{source === "incident" ? active?.description : sourceBook?.body}</p>
        {sourceBook && (
          <small>
            Fictional demo procedure · reviewed {sourceBook.updated}
          </small>
        )}
      </dialog>
    </div>
  );
}
