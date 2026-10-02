"use client";

import { FormEvent, useState } from "react";
import { apiFetch } from "./api-client";

export default function PasswordChangeForm({ onComplete }: { onComplete?: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (newPassword.length < 8 || newPassword.length > 128) {
      setFeedback({ kind: "error", text: "A nova senha deve ter entre 8 e 128 caracteres." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setFeedback({ kind: "error", text: "A confirmação não corresponde à nova senha." });
      return;
    }

    setBusy(true);
    try {
      const response = await apiFetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
        cache: "no-store",
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Não foi possível alterar a senha.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setFeedback({ kind: "success", text: "Senha alterada com sucesso." });
      onComplete?.();
    } catch (error) {
      setFeedback({ kind: "error", text: error instanceof Error ? error.message : "Não foi possível alterar a senha." });
    } finally {
      setBusy(false);
    }
  }

  return <section className="password-panel" aria-labelledby="password-change-title">
      <div><h3 id="password-change-title">Alterar senha</h3><p>Confirme sua senha atual para cadastrar uma nova. Se você recebeu uma senha redefinida pelo administrador, use-a aqui.</p></div>
    <form className="password-form" onSubmit={submit}>
      <label>Senha atual<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label>
      <label>Nova senha<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required /><small>Mínimo de 8 caracteres.</small></label>
      <label>Confirmar nova senha<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required /></label>
      {feedback && <p className={`password-feedback ${feedback.kind}`} role="status">{feedback.text}</p>}
      <button className="primary" type="submit" disabled={busy}>{busy ? "Alterando…" : "Salvar nova senha"}</button>
    </form>
  </section>;
}
