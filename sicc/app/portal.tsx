"use client";

import { FormEvent, useEffect, useState } from "react";
import SICCApp from "./sicc-app";
import { apiFetch } from "./api-client";
import { requireSupabase } from "./supabase-browser";

type Operator = { id: string; name: string; warName: string; rank: string; email: string; role: "admin" | "operator"; invitedBy: string | null };

const RANKS = ["AL SD", "SD", "CB", "3º SGT", "2º SGT", "1º SGT", "ST", "CAD", "ASP OF", "2º TEN", "1º TEN", "CAP", "MAJ", "TEN CEL", "CEL"];

export default function Portal() {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [loading, setLoading] = useState(true);
  const [bootstrap, setBootstrap] = useState(false);
  const [bootstrapInvite, setBootstrapInvite] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteStatus, setInviteStatus] = useState<"checking" | "valid" | "invalid" | null>(null);
  const [message, setMessage] = useState("");

  async function refresh(bootstrapToken = bootstrapInvite) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const statusPath = bootstrapToken ? `/api/auth/status?bootstrap=${encodeURIComponent(bootstrapToken)}` : "/api/auth/status";
      const response = await apiFetch(statusPath, { cache: "no-store", signal: controller.signal });
      const data = await response.json() as { operator?: Operator | null; bootstrapAllowed?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Não foi possível verificar o acesso.");
      setOperator(data.operator ?? null);
      setBootstrap(Boolean(data.bootstrapAllowed));
      setMessage(bootstrapToken && !data.bootstrapAllowed ? "Link de ativação inválido ou expirado." : "");
    } catch (error) {
      setMessage(error instanceof DOMException && error.name === "AbortError" ? "A verificação demorou demais. Toque em tentar novamente." : (error instanceof Error ? error.message : "Não foi possível verificar o acesso."));
    } finally {
      window.clearTimeout(timeout);
      setLoading(false);
    }
  }
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkedBootstrap = params.get("bootstrap") ?? params.get("ativacao") ?? "";
    const linkedInvite = params.get("convite") ?? params.get("invite") ?? "";
    if (linkedBootstrap.trim()) {
      // The raw token is submitted once over HTTPS and is never persisted.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBootstrapInvite(linkedBootstrap.trim());
      void refresh(linkedBootstrap.trim());
      return;
    }
    if (linkedInvite.trim()) {
      // URL parameters are external input; apply them after mount to avoid a
      // hydration mismatch between the server shell and the browser URL.
      const code = linkedInvite.trim().toUpperCase();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInviteCode(code);
      setInviteStatus("checking");
      void (async () => {
        await refresh();
        try {
          const response = await apiFetch(`/api/auth/invite-status?code=${encodeURIComponent(code)}`, { cache: "no-store" });
          const status = await response.json() as { valid?: boolean; reason?: string };
          if (status.valid) {
            setBootstrap(false);
            setInviteStatus("valid");
            setMode("register");
            return;
          }
          setBootstrap(false);
          setInviteStatus("invalid");
          setMode("login");
          setMessage(
            status.reason === "expired"
              ? "Este link de convite expirou. Solicite outro código de convite ao administrador."
              : status.reason === "used"
                ? "Este convite já foi utilizado. Solicite outro código de convite."
                : "Este link de convite não é válido. Solicite outro código de convite."
          );
        } catch {
          setBootstrap(false);
          setInviteStatus("invalid");
          setMode("login");
          setMessage("Não foi possível validar o convite. Solicite outro código de convite.");
        }
      })();
      return;
    }
    void refresh();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>, endpoint: string) {
    event.preventDefault(); setMessage(""); setLoading(true);
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget).entries());
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 45_000);
      let response: Response;
      try {
        response = await apiFetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      } finally {
        window.clearTimeout(timeout);
      }
      const data = await response.json() as { id?: string; name?: string; warName?: string; rank?: string; email?: string; role?: "admin" | "operator"; invitedBy?: string | null; error?: string; access_token?: string; refresh_token?: string; expires_in?: number };
      if (!response.ok) { setMessage(data.error ?? "Não foi possível concluir."); setLoading(false); return; }
      if (data.access_token && data.refresh_token) {
        await requireSupabase().auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
      }
      // The auth endpoints already return the validated operator profile.
      // Avoid a second status round-trip, which is especially slow on a cold
      // Supabase Edge Function and can trigger a false login timeout.
      if (data.id && data.name && data.email && data.role) {
        setOperator({
          id: data.id,
          name: data.name,
          warName: data.warName ?? data.name,
          rank: data.rank ?? "",
          email: data.email,
          role: data.role,
          invitedBy: data.invitedBy ?? null,
        });
        setLoading(false);
        return;
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof DOMException && error.name === "AbortError" ? "A operação demorou demais. Verifique sua conexão e tente novamente." : (error instanceof Error ? error.message : "Não foi possível concluir."));
      setLoading(false);
    }
  }

  if (loading && !operator) return <main className="auth-shell"><div className="auth-card"><b>Carregando acesso seguro…</b></div></main>;
  if (operator) return <SICCApp operator={operator} onLogout={async () => { await apiFetch("/api/auth/logout", { method: "POST" }); await requireSupabase().auth.signOut(); setOperator(null); setMode("login"); }} />;

  return <main className="auth-shell">
    <section className="auth-brand"><span className="brand-mark">SI</span><div><b>SICC</b><small>Sistema Integrado de Cadastro e Consulta</small></div></section>
    <section className="auth-card">
      {message && <div className="auth-error">{message} <button type="button" className="text-button" onClick={() => { setMessage(""); setLoading(true); void refresh(); }}>Tentar novamente</button></div>}
      {bootstrap ? <><small className="eyebrow">ATIVAÇÃO INICIAL</small><h1>Criar conta administradora</h1><p>{bootstrapInvite ? "Link de ativação válido. Ele só pode ser usado uma vez." : "Disponível somente para o proprietário autenticado."}</p>
        <form onSubmit={(event) => submit(event, "/api/auth/bootstrap")}>{bootstrapInvite ? <input type="hidden" name="bootstrapInvite" value={bootstrapInvite} /> : <label>Código de ativação<input name="bootstrapKey" required autoComplete="off" /></label>}<label className="auth-select-field"><span>Posto ou graduação</span><div className="auth-select-wrap"><select name="rank" required defaultValue=""><option value="" disabled>Selecione seu posto ou graduação</option>{RANKS.map((rank) => <option key={rank}>{rank}</option>)}</select></div></label><label>Nome de guerra<input name="warName" required minLength={2} placeholder="Ex.: FULANO" /></label><label>E-mail do administrador<input name="email" type="email" required autoComplete="email" placeholder="seu e-mail" /></label><label>Senha<input name="password" type="password" required minLength={8} autoComplete="new-password" /></label><button className="primary" disabled={loading}>Ativar conta</button></form>
      </> : <><div className="auth-tabs"><button className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setMessage(""); }}>Entrar</button><button className={mode === "register" ? "active" : ""} onClick={() => { setMode("register"); setMessage(""); }}>Cadastrar</button></div>
        {mode === "login" ? <form onSubmit={(event) => submit(event, "/api/auth/login")}><h1>Acesso do operador</h1><label>E-mail<input name="email" type="email" required autoComplete="email" /></label><label>Senha<input name="password" type="password" required autoComplete="current-password" /></label><button className="primary" disabled={loading}>Entrar</button></form>
        : inviteStatus === "checking" ? <section className="invite-required"><div className="invite-required-icon" aria-hidden="true">…</div><h1>Validando convite</h1><p>Estamos verificando o link de convite. Aguarde um instante.</p></section>
        : inviteCode.trim() && inviteStatus === "valid" ? <form onSubmit={(event) => submit(event, "/api/auth/register")}><h1>Novo operador</h1><p>É necessário um código de convite válido.</p><div className="invite-help"><b>Convite identificado</b><span>Preencha os dados abaixo. O convite será validado antes da criação da conta.</span></div><label>Código de convite<input name="invite" required value={inviteCode} onChange={(event) => setInviteCode(event.target.value.toUpperCase())} placeholder="Código preenchido pelo link" /></label><label className="auth-select-field"><span>Posto ou graduação</span><div className="auth-select-wrap"><select name="rank" required defaultValue=""><option value="" disabled>Selecione seu posto ou graduação</option>{RANKS.map((rank) => <option key={rank}>{rank}</option>)}</select></div></label><label>Nome de guerra<input name="warName" required minLength={2} placeholder="Ex.: CICRANO" /></label><label>E-mail<input name="email" type="email" required autoComplete="email" /></label><label>Senha<input name="password" type="password" required minLength={8} autoComplete="new-password" /></label><button className="primary" disabled={loading}>Criar conta</button></form> : <section className="invite-required"><div className="invite-required-icon" aria-hidden="true">⌁</div><h1>Convite necessário</h1><p>Este cadastro só pode ser iniciado por um link de convite. Solicite a um operador que já tenha acesso ao SICC que gere e envie o link para você.</p><button type="button" className="secondary" onClick={() => { setMode("login"); setMessage(""); }}>Voltar para entrar</button></section>}
      </>}
    </section>
  </main>;
}
