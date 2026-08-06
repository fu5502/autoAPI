import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, Check, Clipboard, Copy, Eraser, Eye, EyeOff, FlaskConical, History, LoaderCircle, Pencil, RefreshCw, RotateCcw, Send, Settings2, Trash2, User, UserRoundPlus } from "lucide-react";
import { api } from "../api";
import type { Channel, PlaygroundSession } from "../types";

type PlaygroundRole = "system" | "user" | "assistant";

interface PlaygroundMessage {
  id: string;
  role: PlaygroundRole;
  content: string;
  latencyMs?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  model?: string;
  channelId?: string;
  providerName?: string;
  channelName?: string;
  streaming?: boolean;
}

function createClientId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const values = new Uint32Array(4);
    globalThis.crypto.getRandomValues(values);
    return Array.from(values).map((value) => value.toString(16)).join("-");
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function Playground({ channels, onUpdated }: { channels: Channel[]; onUpdated: () => void }) {
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [model, setModel] = useState(channels[0]?.models[0] ?? "");
  const [sessionId, setSessionId] = useState<string>(() => createClientId());
  const [messages, setMessages] = useState<PlaygroundMessage[]>([]);
  const [input, setInput] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(1);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [frequencyPenalty, setFrequencyPenalty] = useState(0);
  const [presencePenalty, setPresencePenalty] = useState(0);
  const [stream, setStream] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const activeRequestIdRef = useRef<string | null>(null);
  const sessions = useQuery({ queryKey: ["playground-sessions"], queryFn: api.playgroundSessions });

  const selectedChannel = channels.find((channel) => channel.id === channelId) ?? (channelId ? null : channels[0] ?? null);
  const selectedModels = selectedChannel?.models ?? [];
  const chatMessages = messages.filter((message) => message.role !== "system");

  const send = useMutation({
    mutationFn: (variables: { content: string; history: PlaygroundMessage[]; model: string; channelId: string; stream: boolean; requestId: string; assistantMessageId: string; requestSessionId: string }) => {
      const nextMessages = [...variables.history, { id: createClientId(), role: "user" as const, content: variables.content }];
      return api.playgroundChat({
        sessionId: variables.requestSessionId,
        channelId: variables.channelId,
        model: variables.model,
        messages: nextMessages.map(({ role, content, model: messageModel, channelId: messageChannelId, channelName, providerName }) => ({
          role,
          content,
          ...(messageModel ? { model: messageModel } : {}),
          ...(messageChannelId ? { channelId: messageChannelId } : {}),
          ...(channelName ? { channelName } : {}),
          ...(providerName ? { providerName } : {}),
        })),
        temperature,
        topP,
        maxTokens,
        frequencyPenalty,
        presencePenalty,
        stream: variables.stream,
      }, variables.stream ? (delta) => {
        setMessages((current) => current.map((message) => message.id === variables.assistantMessageId
          ? { ...message, content: `${message.content}${delta}` }
          : message));
      } : undefined);
    },
    onMutate: (variables) => {
      const userId = createClientId();
      setMessages((current) => [...current, { id: userId, role: "user", content: variables.content }, ...(variables.stream ? [{ id: variables.assistantMessageId, role: "assistant" as const, content: "", streaming: true }] : [])]);
      activeRequestIdRef.current = variables.requestId;
      setInput("");
    },
    onSuccess: (result, variables) => {
      if (activeRequestIdRef.current !== variables.requestId) return;
      setMessages((current) => {
        const assistant = {
          id: variables.stream ? variables.assistantMessageId : createClientId(),
          role: "assistant" as const,
          content: result.message,
          latencyMs: result.latencyMs,
          usage: result.usage,
          model: result.model,
          channelName: result.channelName,
          providerName: result.providerName,
          streaming: false,
        };
        if (!variables.stream) return [...current, assistant];
        return current.map((message) => message.id === variables.assistantMessageId ? assistant : message);
      });
      activeRequestIdRef.current = null;
      setSessionId(result.sessionId);
      void sessions.refetch();
      onUpdated();
    },
    onError: (reason, variables) => {
      if (activeRequestIdRef.current !== variables.requestId) return;
      const requestChannel = channels.find((channel) => channel.id === variables.channelId);
      setMessages((current) => {
        const failed = {
          id: variables.stream ? variables.assistantMessageId : createClientId(),
          role: "assistant" as const,
          content: reason instanceof Error ? reason.message : "测试请求失败。",
          model: variables.model,
          ...(requestChannel ? { channelId: requestChannel.id, channelName: requestChannel.name, providerName: requestChannel.providerName } : {}),
          streaming: false,
        };
        return variables.stream ? current.map((message) => message.id === variables.assistantMessageId ? failed : message) : [...current, failed];
      });
      activeRequestIdRef.current = null;
      void sessions.refetch();
      onUpdated();
    },
  });

  const canSend = Boolean(selectedChannel && model && input.trim() && !send.isPending);

  useEffect(() => {
    if (!selectedChannel) {
      setChannelId("");
      setModel("");
      return;
    }
    if (selectedChannel.id !== channelId) setChannelId(selectedChannel.id);
    if (!selectedModels.includes(model)) setModel(selectedModels[0] ?? "");
  }, [channelId, model, selectedChannel, selectedModels]);

  function changeChannel(nextId: string) {
    const nextChannel = channels.find((channel) => channel.id === nextId);
    setChannelId(nextId);
    setModel(nextChannel?.models[0] ?? "");
  }

  function clearConversation() {
    setMessages([]);
    setSessionId(createClientId());
    activeRequestIdRef.current = null;
    send.reset();
  }

  function deleteMessage(id: string) {
    setMessages((current) => current.filter((message) => message.id !== id));
  }

  function editMessage(message: PlaygroundMessage) {
    setInput(message.content);
    setMessages((current) => {
      const index = current.findIndex((item) => item.id === message.id);
      return index < 0 ? current : current.slice(0, index);
    });
  }

  function regenerateMessage(message: PlaygroundMessage) {
    const index = messages.findIndex((item) => item.id === message.id);
    if (index < 0 || send.isPending) return;
    const userIndex = message.role === "user" ? index : [...messages.slice(0, index)].map((item) => item.role).lastIndexOf("user");
    const userMessage = messages[userIndex];
    if (!userMessage || userMessage.role !== "user" || !selectedChannel || !model) return;
    setMessages((current) => current.slice(0, userIndex));
    send.mutate({ content: userMessage.content, history: messages.slice(0, userIndex), model, channelId: selectedChannel.id, stream, requestId: createClientId(), assistantMessageId: createClientId(), requestSessionId: sessionId });
  }

  function quoteMessage(message: PlaygroundMessage) {
    setInput((current) => current.trim() ? `${current}\n\n${message.content}` : message.content);
  }

  function loadSession(session: PlaygroundSession) {
    activeRequestIdRef.current = null;
    setSessionId(session.id);
    setChannelId(session.channelId ?? "");
    setModel(session.model);
    setTemperature(session.temperature ?? 0.7);
    setTopP(session.topP ?? 1);
    setMaxTokens(session.maxTokens ?? 1024);
    setFrequencyPenalty(session.frequencyPenalty ?? 0);
    setPresencePenalty(session.presencePenalty ?? 0);
    setStream(session.stream ?? true);
    setMessages(session.messages.map((message, index) => ({
      id: `${session.id}-${index}`,
      role: message.role,
      content: message.content,
      ...(message.latencyMs === undefined ? {} : { latencyMs: message.latencyMs }),
      ...(message.promptTokens === undefined ? {} : { usage: {
        promptTokens: message.promptTokens,
        completionTokens: message.completionTokens ?? 0,
        totalTokens: message.totalTokens ?? (message.promptTokens + (message.completionTokens ?? 0)),
      } }),
      ...(message.model ? { model: message.model } : message.role === "assistant" ? { model: session.model } : {}),
      ...(message.channelId ? { channelId: message.channelId } : {}),
      ...(message.channelName ? { channelName: message.channelName } : message.role === "assistant" ? { channelName: session.channelName } : {}),
      ...(message.providerName ? { providerName: message.providerName } : message.role === "assistant" ? { providerName: session.providerName } : {}),
      ...(message.errorType ? { channelName: `${message.channelName ?? session.channelName} · ${message.errorType}` } : {}),
    })));
  }

  async function removeSession(id: string) {
    await api.deletePlaygroundSession(id);
    if (id === sessionId) {
      setSessionId(createClientId());
      setMessages([]);
      activeRequestIdRef.current = null;
    }
    await sessions.refetch();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    sendCurrentMessage();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendCurrentMessage();
    }
  }

  function sendCurrentMessage() {
    const content = input.trim();
    if (!selectedChannel || !model || !content || send.isPending) return;
    send.mutate({ content, history: messages, model, channelId: selectedChannel.id, stream, requestId: createClientId(), assistantMessageId: createClientId(), requestSessionId: sessionId });
  }

  async function copyMessage(message: PlaygroundMessage) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      window.setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard permissions are optional; the response remains selectable.
    }
  }

  return (
    <div className="playground-layout">
      <aside className="playground-config surface">
        <div className="playground-config-head"><span className="playground-icon"><Settings2 size={17} /></span><div><h2>模型配置</h2><span>选择渠道和参数</span></div></div>
        <div className="playground-config-body">
          <div className="playground-status"><span className={`status-dot status-${selectedChannel?.status ?? "disabled"}`} /><span>{selectedChannel ? `${selectedChannel.name} · ${selectedChannel.status === "healthy" ? "健康" : selectedChannel.status === "pending" ? "待检测" : "可测试"}` : "请先添加渠道"}</span></div>
          <label className="playground-stream-toggle"><input type="checkbox" checked={stream} onChange={(event) => setStream(event.target.checked)} /><span><strong>流式</strong><small>实时接收回复</small></span></label>
          <div className="playground-divider" />
          <ParameterSlider label="随机性与创造性" description="控制输出的随机性和创造性" value={temperature} min={0} max={2} step={0.1} onChange={setTemperature} />
          <ParameterSlider label="核采样" description="控制词汇选择的多样性" value={topP} min={0} max={1} step={0.05} onChange={setTopP} />
          <ParameterSlider label="频率惩罚" description="减少重复词汇的出现" value={frequencyPenalty} min={-2} max={2} step={0.1} onChange={setFrequencyPenalty} />
          <ParameterSlider label="存在惩罚" description="减少已经出现过的词汇再次出现" value={presencePenalty} min={-2} max={2} step={0.1} onChange={setPresencePenalty} />
          <div className="field"><label htmlFor="playground-max-tokens">最大输出令牌数</label><span className="field-hint">限制单次回复的最长长度</span><input id="playground-max-tokens" type="number" min="1" max="32000" step="1" value={maxTokens} onChange={(event) => setMaxTokens(Math.max(1, Number(event.target.value) || 1))} /></div>
        </div>
        <div className="playground-config-foot"><button className="button secondary" onClick={clearConversation} disabled={!messages.length}><Eraser size={15} /> 清空会话</button><span>{chatMessages.length} 条消息</span></div>
        <div className="playground-history">
          <div className="playground-history-head"><span><History size={14} /> 测试记录</span><small>{sessions.data?.length ?? 0}</small></div>
          {sessions.isLoading ? <div className="playground-history-empty">正在加载记录…</div> : null}
          {!sessions.isLoading && !sessions.data?.length ? <div className="playground-history-empty">暂无历史测试</div> : null}
          <div className="playground-history-list">
            {sessions.data?.map((record) => <div className={`playground-history-item${record.id === sessionId ? " active" : ""}`} key={record.id}>
              <button className="playground-history-main" onClick={() => loadSession(record)}>
                <strong>{record.model}</strong>
                <span>{record.channelName} · {formatRecordTime(record.updatedAt)}</span>
                <small>{record.messages.length} 条消息</small>
              </button>
              <button className="icon-button danger-button playground-history-delete" title="删除测试记录" aria-label={`删除测试记录 ${record.model}`} onClick={() => void removeSession(record.id)}><Trash2 size={13} /></button>
            </div>)}
          </div>
        </div>
      </aside>

      <section className="playground-chat surface">
        <header className="playground-chat-head">
          <div className="playground-chat-title"><span className="playground-icon"><FlaskConical size={17} /></span><div><h2>AI 对话</h2><span>{model || "未选择模型"}</span></div></div>
          <div className="playground-chat-actions">
            <button className={showDebug ? "playground-debug active" : "playground-debug"} type="button" onClick={() => setShowDebug((current) => !current)} title={showDebug ? "隐藏调试信息" : "显示调试信息"}><>{showDebug ? <EyeOff size={16} /> : <Eye size={16} />} 显示调试</></button>
            <span className="playground-live"><span className="live-dot" /> 结果计入用量</span>
            <button className="icon-button" title="清空会话" aria-label="清空会话" onClick={clearConversation} disabled={!messages.length}><RotateCcw size={16} /></button>
          </div>
        </header>
        <div className="playground-messages" aria-live="polite">
          {!messages.length ? <div className="playground-empty"><span className="playground-empty-icon"><Bot size={25} /></span><h3>开始测试模型</h3><p>选择渠道和模型，发送第一条消息。</p></div> : messages.map((message) => <MessageBubble message={message} copied={copiedId === message.id} showDebug={showDebug} onCopy={() => void copyMessage(message)} onDelete={() => deleteMessage(message.id)} onEdit={() => editMessage(message)} onRegenerate={() => regenerateMessage(message)} onQuote={() => quoteMessage(message)} key={message.id} />)}
          {send.isPending ? <div className="playground-pending"><LoaderCircle size={16} className="spin" /> 正在请求 {model}…</div> : null}
          <div className="playground-bottom-anchor" />
        </div>
        <form className="playground-composer" onSubmit={submit}>
          <div className="playground-composer-channel">
            <label htmlFor="playground-channel">渠道</label>
            <select id="playground-channel" value={channelId} onChange={(event) => changeChannel(event.target.value)} disabled={!channels.length || send.isPending}>
              <option value="">暂无可用渠道</option>
              {channels.map((channel) => <option value={channel.id} key={channel.id}>{channel.name} · {channel.protocol}</option>)}
            </select>
          </div>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleInputKeyDown} disabled={!selectedChannel || !model || send.isPending} placeholder={selectedChannel && model ? "请输入您的问题..." : "请先选择渠道和模型"} rows={2} />
          <div className="playground-composer-toolbar">
            <button className="icon-button playground-clear-input" type="button" title="清空会话" aria-label="清空会话" onClick={clearConversation} disabled={!messages.length}><Trash2 size={17} /></button>
            <div className="playground-composer-spacer" />
            <label className="playground-composer-model" htmlFor="playground-model"><span>模型</span><select id="playground-model" value={model} onChange={(event) => setModel(event.target.value)} disabled={!selectedModels.length || send.isPending}><option value="">暂无已配置模型</option>{selectedModels.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
            <button className="playground-send" type="submit" title="发送消息" aria-label="发送消息" disabled={!canSend}><Send size={18} /></button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ParameterSlider({ label, description, value, min, max, step, onChange }: { label: string; description: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  return <div className="playground-slider"><div><div className="playground-slider-label"><label htmlFor={`playground-${label}`}>{label}</label><span>{description}</span></div><output>{value}</output></div><input id={`playground-${label}`} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></div>;
}

function MessageBubble({ message, copied, showDebug, onCopy, onDelete, onEdit, onRegenerate, onQuote }: { message: PlaygroundMessage; copied: boolean; showDebug: boolean; onCopy: () => void; onDelete: () => void; onEdit: () => void; onRegenerate: () => void; onQuote: () => void }) {
  const assistant = message.role === "assistant";
  const source = assistant ? [message.model, message.channelName].filter(Boolean).join(" · ") : null;
  return <article className={assistant ? "playground-message assistant" : "playground-message user"}><div className="playground-avatar">{assistant ? <Bot size={15} /> : <User size={15} />}</div><div className="playground-message-body">{assistant ? <div className="playground-message-meta"><strong>模型回答</strong>{source ? <span>{source}</span> : null}</div> : null}<div className="playground-message-content">{message.content}</div><div className="playground-message-tools"><button className="icon-button" type="button" title="重新生成" aria-label="重新生成" onClick={onRegenerate}><RefreshCw size={15} /></button><button className="icon-button" type="button" title={copied ? "已复制" : "复制内容"} aria-label={copied ? "已复制" : "复制内容"} onClick={onCopy}>{copied ? <Check size={15} /> : <Copy size={15} />}</button><button className="icon-button" type="button" title="编辑消息" aria-label="编辑消息" onClick={onEdit}><Pencil size={15} /></button>{assistant ? <button className="icon-button" type="button" title="引用回复" aria-label="引用回复" onClick={onQuote}><UserRoundPlus size={15} /></button> : null}<button className="icon-button danger-button" type="button" title="删除消息" aria-label="删除消息" onClick={onDelete}><Trash2 size={15} /></button></div>{showDebug && assistant ? <div className="playground-debug-panel"><span>模型：{message.model || "-"}</span><span>渠道：{message.channelName || "-"}</span><span>供应商：{message.providerName || "-"}</span><span>延迟：{message.latencyMs ? `${message.latencyMs} ms` : "-"}</span>{message.usage ? <span>Token：{message.usage.totalTokens}</span> : null}</div> : null}</div></article>;
}

function formatRecordTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
