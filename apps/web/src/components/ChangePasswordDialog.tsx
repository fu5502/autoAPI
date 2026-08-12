import { useEffect, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, X } from "lucide-react";
import { api } from "../api";

export function ChangePasswordDialog({ open, username, onClose }: { open: boolean; username: string; onClose: () => void }) {
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const changePassword = useMutation({ mutationFn: api.changePassword });

  useEffect(() => {
    if (!open) {
      setMessage(null);
      changePassword.reset();
    }
  }, [open]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (newPassword !== confirmPassword) {
      setMessage({ type: "error", text: "两次输入的新密码不一致。" });
      return;
    }
    setMessage(null);
    changePassword.mutate({ currentPassword, newPassword }, {
      onSuccess: () => {
        formElement.reset();
        setMessage({ type: "ok", text: "密码已修改，下次登录请使用新密码。" });
      },
      onError: (error) => setMessage({ type: "error", text: error instanceof Error ? error.message : "密码修改失败。" }),
    });
  }

  return (
    <div className={open ? "modal-layer open" : "modal-layer"} aria-hidden={!open}>
      <button className="drawer-backdrop" aria-label="关闭密码修改弹窗" onClick={onClose} />
      <section className="modal security-modal" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
        <div className="drawer-head">
          <div><span className="drawer-icon"><KeyRound size={17} /></span><h2 id="change-password-title">修改密码</h2></div>
          <button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <form className="security-form" onSubmit={submit}>
          <label className="field"><span>当前密码</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
          <label className="field"><span>新密码</span><input name="newPassword" type="password" autoComplete="new-password" minLength={8} required /><small>至少 8 个字符。</small></label>
          <label className="field"><span>确认新密码</span><input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} required /></label>
          {message ? <div className={`form-notice${message.type === "ok" ? " form-notice-ok" : " form-notice-error"}`} role="status">{message.text}</div> : null}
          <button className="button primary" disabled={changePassword.isPending}>{changePassword.isPending ? "保存中…" : "保存新密码"}</button>
        </form>
      </section>
    </div>
  );
}
