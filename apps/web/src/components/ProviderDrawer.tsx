import { useRef, useState, type FormEvent } from "react";
import { KeyRound, RefreshCw, X } from "lucide-react";
import { api } from "../api";

export function ProviderDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [models, setModels] = useState("");
  const [protocol, setProtocol] = useState("auto");
  const formRef = useRef<HTMLFormElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const formElement = event.currentTarget;
    try {
      await api.importProvider({
        name: form.get("name"),
        keyName: String(form.get("keyName") ?? "").trim() || "API Key",
        baseUrl: form.get("baseUrl"),
        faviconUrl: String(form.get("faviconUrl") ?? "").trim() || null,
        apiKey: form.get("apiKey"),
        protocol: form.get("protocol"),
        models: String(form.get("models") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
        priority: Number(form.get("priority")),
        weight: Number(form.get("weight")),
        tags: String(form.get("tags") ?? "").split(",").map((item) => item.trim()).filter(Boolean),
      });
      formElement.reset();
      setDiscoveredModels([]);
      setModels("");
      setProtocol("auto");
      onCreated();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "渠道添加失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function discoverModels() {
    const form = formRef.current;
    if (!form) return;
    setDiscovering(true);
    setError(null);
    const values = new FormData(form);
    try {
      const result = await api.discoverModels({
        baseUrl: values.get("baseUrl"),
        apiKey: values.get("apiKey"),
        protocol,
        models: splitList(models),
      });
      setDiscoveredModels(result.models);
      if (result.error && result.models.length === 0) setError(`模型获取失败：${result.error}`);
      if (result.protocol !== "auto" && protocol === "auto") {
        setProtocol(result.protocol);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型获取失败");
    } finally {
      setDiscovering(false);
    }
  }

  function toggleModel(model: string) {
    const selected = splitList(models);
    setModels(selected.includes(model) ? selected.filter((item) => item !== model).join(", ") : [...selected, model].join(", "));
  }

  if (!open) return null;

  return (
    <div className="drawer-layer open">
      <button className="drawer-backdrop" aria-label="关闭抽屉" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="provider-title">
        <div className="drawer-head">
          <div><span className="drawer-icon"><KeyRound size={17} /></span><h2 id="provider-title">添加渠道</h2></div>
          <button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <form ref={formRef} onSubmit={submit}>
          <div className="field"><label htmlFor="name">渠道名称</label><input id="name" name="name" required placeholder="例如：主用渠道" /></div>
          <div className="field"><label htmlFor="keyName">密钥名称</label><input id="keyName" name="keyName" maxLength={120} placeholder="例如：WorkBuddy" /></div>
          <div className="field"><label htmlFor="baseUrl">Base URL</label><input id="baseUrl" name="baseUrl" type="url" required placeholder="https://api.example.com/v1" /></div>
          <div className="field"><label htmlFor="faviconUrl">自定义渠道图标 <small>可选，留空自动获取</small></label><input id="faviconUrl" name="faviconUrl" type="url" placeholder="https://example.com/icon.png" /></div>
          <div className="field"><label htmlFor="apiKey">API Key</label><input id="apiKey" name="apiKey" type="password" required autoComplete="off" placeholder="sk-..." /></div>
          <div className="field"><label htmlFor="protocol">协议类型</label><select id="protocol" name="protocol" value={protocol} onChange={(event) => setProtocol(event.target.value)}><option value="auto">自动识别</option><option value="openai">OpenAI 兼容</option><option value="claude">Claude 兼容</option><option value="gemini">Gemini 兼容</option><option value="new-api">New API</option><option value="sub2api">Sub2API</option></select></div>
          <div className="field"><label htmlFor="models">已知模型</label><div className="model-input-row"><input id="models" name="models" value={models} onChange={(event) => setModels(event.target.value)} placeholder="gpt-5-codex, gpt-5" /><button type="button" className="button secondary" onClick={() => void discoverModels()} disabled={discovering}><RefreshCw size={14} className={discovering ? "spin" : ""} /> {discovering ? "获取中…" : "获取模型列表"}</button></div><span>可选，填写 Base URL 和 API Key 后获取；点击模型即可加入或移除</span>{discoveredModels.length > 0 ? <div className="model-picker" aria-label="可选模型">{discoveredModels.map((model) => <button type="button" className={splitList(models).includes(model) ? "model-chip selected" : "model-chip"} key={model} onClick={() => toggleModel(model)}>{model}</button>)}</div> : null}</div>
          <div className="field-row">
            <div className="field"><label htmlFor="priority">优先级</label><input id="priority" name="priority" type="number" defaultValue="0" min="-100" max="100" /></div>
            <div className="field"><label htmlFor="weight">权重</label><input id="weight" name="weight" type="number" defaultValue="100" min="1" max="10000" /></div>
          </div>
          <div className="field"><label htmlFor="tags">标签</label><input id="tags" name="tags" placeholder="codex, primary" /></div>
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          <div className="drawer-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={submitting}>{submitting ? "正在添加…" : "添加渠道"}</button></div>
        </form>
      </aside>
    </div>
  );
}

function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
