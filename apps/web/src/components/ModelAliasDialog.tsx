import { useState, type FormEvent } from "react";
import { GitBranch, X } from "lucide-react";
import { api } from "../api";
import type { Channel } from "../types";

export function ModelAliasDialog({ open, channels, onClose, onCreated }: { open: boolean; channels: Channel[]; onClose: () => void; onCreated: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      await api.addAlias({ alias: form.get("alias"), channelId: form.get("channelId"), upstreamModel: form.get("upstreamModel"), enabled: true });
      event.currentTarget.reset();
      onCreated();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型路由创建失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={open ? "modal-layer open" : "modal-layer"} aria-hidden={!open}>
      <button className="drawer-backdrop" aria-label="关闭对话框" onClick={onClose} />
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="alias-title">
        <div className="drawer-head">
          <div><span className="drawer-icon"><GitBranch size={17} /></span><h2 id="alias-title">添加模型路由</h2></div>
          <button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={submit}>
          <div className="field"><label htmlFor="alias">客户端模型别名</label><input id="alias" name="alias" required placeholder="gpt-5-codex" /></div>
          <div className="field"><label htmlFor="channelId">渠道</label><select id="channelId" name="channelId" required defaultValue=""><option value="" disabled>请选择渠道</option>{channels.map((channel) => <option value={channel.id} key={channel.id}>{channel.name} · {channel.protocol}</option>)}</select></div>
          <div className="field"><label htmlFor="upstreamModel">上游模型</label><input id="upstreamModel" name="upstreamModel" required placeholder="gpt-5.1-codex" /></div>
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          <div className="drawer-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={submitting}>{submitting ? "添加中…" : "添加路由"}</button></div>
        </form>
      </section>
    </div>
  );
}
