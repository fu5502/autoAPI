import { CheckCircle2, CircleAlert, Clock3, Coins, Layers3, X } from "lucide-react";
import type { ProbeResponse } from "../types";

export function ProbeResultDialog({ result, onClose }: { result: ProbeResponse | null; onClose: () => void }) {
  if (!result) return null;
  const { probe, channel } = result;
  const statusLabel = probe.ok ? "探测成功" : "探测失败";
  return (
    <div className="modal-layer open">
      <button className="drawer-backdrop" aria-label="关闭探测结果" onClick={onClose} />
      <section className="modal probe-result-modal" role="dialog" aria-modal="true" aria-labelledby="probe-result-title">
        <header className="probe-result-head">
          <div><span className={probe.ok ? "probe-result-icon success" : "probe-result-icon failure"}>{probe.ok ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}</span><div><h2 id="probe-result-title">渠道探测结果</h2><span>{channel?.name ?? "未知渠道"} · {statusLabel}</span></div></div>
          <button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="probe-result-content">
          <div className="probe-result-metrics">
            <div><span>协议</span><strong>{probe.protocol}</strong></div>
            <div><span>延迟</span><strong><Clock3 size={13} /> {probe.latencyMs} ms</strong></div>
            <div><span>余额</span><strong><Coins size={13} /> {formatBalance(probe.balance, probe.balanceCurrency, probe.balanceStatus)}</strong></div>
          </div>
          <div className="probe-checks"><span className={probe.chatOk ? "check-ok" : "check-fail"}>{probe.chatOk ? "✓" : "×"} 非流式请求</span><span className={probe.streamOk ? "check-ok" : "check-fail"}>{probe.streamOk ? "✓" : "×"} 流式请求</span></div>
          <div className="probe-models-section"><div className="probe-models-title"><span><Layers3 size={15} /> 探测到的模型</span><strong>{probe.models.length}</strong></div>{probe.models.length ? <div className="probe-model-list">{probe.models.map((model) => <span className="probe-model-item" key={model}>{model}</span>)}</div> : <div className="probe-empty">上游没有返回模型列表。</div>}</div>
          {probe.error ? <div className="form-error" role="alert">{probe.error}</div> : null}
          <p className="probe-result-note">模型列表仅供查看，不会自动覆盖当前已配置模型或加入模型池。</p>
        </div>
        <footer className="drawer-actions probe-result-actions"><button className="button primary" onClick={onClose}>完成</button></footer>
      </section>
    </div>
  );
}

function formatBalance(balance: number | null, currency: string | null, status: string): string {
  if (balance !== null) return `${currency ?? ""} ${balance.toLocaleString("zh-CN", { maximumFractionDigits: 8 })}`.trim();
  if (status === "unknown") return "未知";
  return status;
}
