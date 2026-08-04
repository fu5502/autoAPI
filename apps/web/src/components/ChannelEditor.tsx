import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, RefreshCw, X } from "lucide-react";
import { api } from "../api";
import type { Channel } from "../types";

export function ChannelEditor({ channel, onClose, onSaved }: { channel: Channel | null; onClose: () => void; onSaved: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState<Channel["protocol"]>("auto");
  const [models, setModels] = useState("");
  const [priority, setPriority] = useState("0");
  const [weight, setWeight] = useState("100");
  const [minBalance, setMinBalance] = useState("");
  const [balance, setBalance] = useState("");
  const [balanceCurrency, setBalanceCurrency] = useState("USD");
  const [tags, setTags] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);

  useEffect(() => {
    if (!channel) return;
    setName(channel.name);
    setBaseUrl(channel.baseUrl);
    setApiKey("");
    setProtocol(channel.protocol);
    setModels(channel.models.join(", "));
    setPriority(String(channel.priority));
    setWeight(String(channel.weight));
    setMinBalance(channel.minBalance === null ? "" : String(channel.minBalance));
    setBalance(channel.balance === null ? "" : String(channel.balance));
    setBalanceCurrency(channel.balanceCurrency ?? "USD");
    setTags(channel.tags.join(", "));
    setEnabled(channel.enabled);
    setDiscoveredModels([]);
    setError(null);
  }, [channel]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channel) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.updateChannel(channel.id, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        protocol,
        models: splitList(models),
        priority: Number(priority),
        weight: Number(weight),
        minBalance: minBalance.trim() ? Number(minBalance) : null,
        balance: balance.trim() ? Number(balance) : null,
        balanceCurrency: balance.trim() ? balanceCurrency.trim() || "USD" : null,
        tags: splitList(tags),
        enabled,
      });
      onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "渠道保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function discoverModels() {
    if (!channel) return;
    setDiscovering(true);
    setError(null);
    try {
      const result = await api.discoverChannelModels(channel.id, {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        protocol,
      });
      setDiscoveredModels(result.models);
      if (result.error && result.models.length === 0) setError(`模型获取失败：${result.error}`);
      if (result.protocol !== "auto" && protocol === "auto") setProtocol(result.protocol as Channel["protocol"]);
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

  return (
    <div className={channel ? "drawer-layer open" : "drawer-layer"} aria-hidden={!channel}>
      <button className="drawer-backdrop" aria-label="关闭编辑" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="channel-editor-title">
        <div className="drawer-head">
          <div><span className="drawer-icon"><KeyRound size={17} /></span><h2 id="channel-editor-title">编辑渠道</h2></div>
          <button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <form onSubmit={submit}>
          <div className="field"><label htmlFor="edit-name">渠道名称</label><input id="edit-name" value={name} onChange={(event) => setName(event.target.value)} required /></div>
          <div className="field"><label htmlFor="edit-base-url">Base URL</label><input id="edit-base-url" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required /></div>
          <div className="field"><label htmlFor="edit-api-key">API Key</label><input id="edit-api-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" placeholder="留空表示保留当前密钥" /></div>
          <div className="field"><label htmlFor="edit-protocol">协议类型</label><select id="edit-protocol" value={protocol} onChange={(event) => setProtocol(event.target.value as Channel["protocol"])}><option value="auto">自动识别</option><option value="openai">OpenAI 兼容</option><option value="claude">Claude 兼容</option><option value="gemini">Gemini 兼容</option><option value="new-api">New API</option><option value="sub2api">Sub2API</option></select></div>
          <div className="field"><label htmlFor="edit-models">已知模型</label><div className="model-input-row"><input id="edit-models" value={models} onChange={(event) => setModels(event.target.value)} placeholder="gpt-5-codex, gpt-5" /><button type="button" className="button secondary" onClick={() => void discoverModels()} disabled={discovering}><RefreshCw size={14} className={discovering ? "spin" : ""} /> {discovering ? "获取中…" : "获取模型列表"}</button></div><span>可读取当前渠道模型；点击模型即可加入或移除，保存后才会更新模型池</span>{discoveredModels.length > 0 ? <div className="model-picker" aria-label="可选模型">{discoveredModels.map((model) => <button type="button" className={splitList(models).includes(model) ? "model-chip selected" : "model-chip"} key={model} onClick={() => toggleModel(model)}>{model}</button>)}</div> : null}</div>
          <div className="field-row">
            <div className="field"><label htmlFor="edit-priority">优先级</label><input id="edit-priority" type="number" value={priority} onChange={(event) => setPriority(event.target.value)} min="-100" max="100" /></div>
            <div className="field"><label htmlFor="edit-weight">权重</label><input id="edit-weight" type="number" value={weight} onChange={(event) => setWeight(event.target.value)} min="1" max="10000" /></div>
          </div>
          <div className="field-row">
            <div className="field"><label htmlFor="edit-min-balance">最低余额</label><input id="edit-min-balance" type="number" value={minBalance} onChange={(event) => setMinBalance(event.target.value)} min="0" step="0.01" placeholder="不限制" /></div>
            <div className="field"><label htmlFor="edit-balance">当前余额</label><input id="edit-balance" type="number" value={balance} onChange={(event) => setBalance(event.target.value)} min="0" step="0.01" placeholder="未知" /></div>
          </div>
          <div className="field-row">
            <div className="field"><label htmlFor="edit-balance-currency">余额币种</label><input id="edit-balance-currency" value={balanceCurrency} onChange={(event) => setBalanceCurrency(event.target.value)} maxLength={12} placeholder="USD" /></div>
            <label className="checkbox-field"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 启用渠道</label>
          </div>
          <div className="field"><label htmlFor="edit-tags">标签</label><input id="edit-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="codex, primary" /></div>
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          <div className="drawer-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={submitting}>{submitting ? "保存中…" : "保存渠道"}</button></div>
        </form>
      </aside>
    </div>
  );
}

function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
