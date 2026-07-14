import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ToolCall,
} from "@earendil-works/pi-ai";

type Waiter = {
  resolve: (result: IteratorResult<AssistantMessageEvent>) => void;
};

export class LocalAssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
  private queue: AssistantMessageEvent[] = [];
  private waiters: Waiter[] = [];
  private closed = false;
  private finalResult?: AssistantMessage;
  private resolveFinal!: (message: AssistantMessage) => void;
  private rejectFinal!: (error: unknown) => void;
  private finalPromise: Promise<AssistantMessage>;

  constructor() {
    this.finalPromise = new Promise<AssistantMessage>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.closed) return;

    let isTerminal = false;
    if (event.type === "done") {
      this.finalResult = event.message;
      this.resolveFinal(event.message);
      isTerminal = true;
    } else if (event.type === "error") {
      this.finalResult = event.error;
      this.resolveFinal(event.error);
      isTerminal = true;
    }

    if (isTerminal) this.closed = true;

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }

    if (isTerminal) this.resolvePendingWaiters();
  }

  end(result?: AssistantMessage): void {
    if (this.closed) return;
    this.closed = true;

    if (result && !this.finalResult) {
      this.finalResult = result;
      this.resolveFinal(result);
    }

    if (!this.finalResult) {
      this.rejectFinal(new Error("assistant stream ended without a final message"));
    }

    this.resolvePendingWaiters();
  }

  result(): Promise<AssistantMessage> {
    return this.finalPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    return {
      next: () => {
        const event = this.queue.shift();
        if (event) return Promise.resolve({ value: event, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
          this.waiters.push({ resolve });
        });
      },
    };
  }

  private resolvePendingWaiters(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }
}

export function createLocalAssistantMessageEventStream(): AssistantMessageEventStream {
  return new LocalAssistantMessageEventStream() as unknown as AssistantMessageEventStream;
}

export function emitTextBlock(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  text: string,
): void {
  const contentIndex = output.content.length;
  const block = { type: "text" as const, text: "" };
  output.content.push(block);
  stream.push({ type: "text_start", contentIndex, partial: output });
  block.text = text;
  if (text) {
    stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
  }
  stream.push({ type: "text_end", contentIndex, content: text, partial: output });
}

export function emitToolCallBlock(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  toolCall: ToolCall,
): void {
  const contentIndex = output.content.length;
  output.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({
    type: "toolcall_delta",
    contentIndex,
    delta: JSON.stringify(toolCall.arguments),
    partial: output,
  });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}
