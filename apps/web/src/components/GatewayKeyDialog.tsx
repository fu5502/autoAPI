import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Trash2, X } from "lucide-react";
import { api } from "../api";

export function GatewayKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const keys = useQuery({
    queryKey: ["gateway-keys"],
    queryFn: api.gatewayKeys,
    enabled: open,
  });
  const createKey = useMutation({
    mutationFn: api.createGatewayKey,
    onSuccess: async (result) => {
      setCreatedKey(result.key);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["gateway-keys"] });
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "访问密钥创建失败。"),
  });
  const deleteKey = useMutation({
    mutationFn: api.deleteGatewayKey,
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["gateway-keys"] });
    },
    onError: (reason) => setError(reason instanceof Error ? reason.message : "访问密钥删除失败。"),
  });

  useEffect(() => {
    if (!open) {
      setCreatedKey(null);
      setCopied(false);
      setError(null);
      setPendingDelete(null);
    }
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const key = String(form.get("key") ?? "").trim();
    createKey.mutate(key ? { name, key } : { name });
    event.currentTarget.reset();
  }

  async function copyCreatedKey() {
    if (!createdKey) return;
    try {
      await copyText(createdKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("复制失败，请手动复制完整密钥。 ");
    }
  }

  function requestDelete(id: string, name: string) {
    setError(null);
    setPendingDelete({ id, name });
  }

  return (
    <div className={open ? "modal-layer open" : "modal-layer"} aria-hidden={!open}>
      <button className="drawer-backdrop" aria-label="关闭访问密钥弹窗" onClick={onClose} />
      <section className="modal gateway-key-modal" role="dialog" aria-modal="true" aria-labelledby="gateway-key-title">
        <div className="drawer-head">
          <div><span className="drawer-icon"><KeyRound size={17} /></span><h2 id="gateway-key-title">访问密钥</h2></div>
          <button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="gateway-key-content">
          <div className="key-intro">用于 Codex、Hermes、Claude Code 等客户端访问 autoAPI 网关。完整密钥只会在创建成功后显示一次。</div>
          {createdKey ? (
            <div className="key-reveal" role="status">
              <div><strong>新密钥已创建</strong><span>请立即复制并保存，关闭弹窗后将无法再次查看。</span></div>
              <div className="key-reveal-value"><code>{createdKey}</code><button className="icon-button" title={copied ? "已复制" : "复制密钥"} aria-label={copied ? "已复制" : "复制密钥"} onClick={() => void copyCreatedKey()}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>
            </div>
          ) : null}
          <form className="gateway-key-form" onSubmit={submit}>
            <div className="field"><label htmlFor="gateway-key-name">密钥名称</label><input id="gateway-key-name" name="name" required maxLength={80} placeholder="例如：我的 Codex" /></div>
            <div className="field"><label htmlFor="gateway-key-value">自定义 API Key（可选）</label><input id="gateway-key-value" name="key" minLength={8} maxLength={300} autoComplete="off" placeholder="留空则自动生成 autoapi_..." /><span>自定义密钥至少 8 个字符；留空会生成随机密钥。</span></div>
            <div className="drawer-actions"><button className="button primary" disabled={createKey.isPending}><KeyRound size={15} /> {createKey.isPending ? "正在创建…" : "新增密钥"}</button></div>
          </form>
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          <div className="gateway-key-list">
            <div className="key-list-head"><strong>已有密钥</strong><span>{keys.data?.length ?? 0} 个</span></div>
            {keys.isLoading ? <div className="key-list-empty">正在加载…</div> : keys.error ? <div className="key-list-empty danger-text">{keys.error instanceof Error ? keys.error.message : "密钥列表加载失败。"}</div> : keys.data?.length ? keys.data.map((key) => (
              <div className="gateway-key-row" key={key.id}>
                <div className="gateway-key-meta"><strong>{key.name}</strong><code>••••••••{key.keyLast4}</code><span>创建于 {formatDate(key.createdAt)}</span></div>
                {pendingDelete?.id === key.id ? (
                  <div className="key-delete-confirm">
                    <span>确认删除？</span>
                    <button className="button secondary" onClick={() => setPendingDelete(null)} disabled={deleteKey.isPending}>取消</button>
                    <button className="button danger-button" onClick={() => { deleteKey.mutate(key.id); setPendingDelete(null); }} disabled={deleteKey.isPending}><Trash2 size={14} /> 删除</button>
                  </div>
                ) : <button className="icon-button danger-button" title={`删除 ${key.name}`} aria-label={`删除 ${key.name}`} onClick={() => requestDelete(key.id, key.name)} disabled={deleteKey.isPending}><Trash2 size={15} /></button>}
              </div>
            )) : <div className="key-list-empty">暂无访问密钥。</div>}
          </div>
        </div>
      </section>
    </div>
  );
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "true");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("copy failed");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
