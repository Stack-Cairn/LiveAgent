import type { ImageJob, ImageStudioClient } from "../../lib/imaging/types";
import {
  applyImageEvent,
  applyJobSnapshot,
  type StudioState,
  snapshotSequence,
  terminalJob,
} from "./studioModel";
import { type Message, message } from "./studioText";

/** Owns exactly one stream per job. A gap always refreshes the authoritative snapshot first. */
export class ImageEventStreams {
  private streams = new Map<string, AbortController>();
  private closed = false;
  constructor(
    private client: ImageStudioClient,
    private read: () => StudioState,
    private write: (state: StudioState) => void,
    private notice: (text: Message) => void,
  ) {}
  close() {
    this.closed = true;
    for (const stream of this.streams.values()) stream.abort();
    this.streams.clear();
  }
  watch(job: ImageJob) {
    if (this.closed) return;
    if (terminalJob(job)) {
      // Snapshots already include all events through lastEventSeq. The backend closes
      // an up-to-date terminal stream without replaying job.finished.
      this.streams.get(job.id)?.abort();
      this.streams.delete(job.id);
      if (job.status === "cancelled")
        this.notice(message("imageStudio.notice.warning.jobCancelledLate"));
      return;
    }
    if (this.streams.has(job.id)) return;
    const controller = new AbortController();
    this.streams.set(job.id, controller);
    let recovering = false;
    const recover = async () => {
      if (recovering || this.closed) return;
      recovering = true;
      controller.abort();
      try {
        const snapshot = await this.client.getJob(job.id);
        if (this.closed) return;
        this.write(applyJobSnapshot(this.read(), snapshot));
        this.streams.delete(job.id);
        if (terminalJob(snapshot)) {
          this.watch(snapshot);
          return;
        }
        if (snapshotSequence(snapshot) === undefined) {
          this.notice(message("imageStudio.notice.warning.snapshotNoCursor"));
          return;
        }
        this.watch(snapshot);
      } catch {
        if (!this.closed) {
          this.streams.delete(job.id);
          this.notice(message("imageStudio.notice.error.snapshotFailed"));
        }
      }
    };
    void this.client
      .subscribe(
        job.id,
        this.read().lastSeqByJob[job.id] ?? 0,
        (event) => {
          if (this.closed || controller.signal.aborted) return;
          const state = applyImageEvent(this.read(), event);
          this.write(state);
          if (state.snapshotNeeded[job.id]) void recover();
          else if (event.type === "job.finished") {
            controller.abort();
            this.streams.delete(job.id);
            // Event payload intentionally omits usage, cancelEffect and complete item output lists.
            void this.client
              .getJob(job.id)
              .then((snapshot) => {
                if (this.closed) return;
                this.write(applyJobSnapshot(this.read(), snapshot));
                this.watch(snapshot);
              })
              .catch(() => {
                if (!this.closed)
                  this.notice(message("imageStudio.notice.warning.finishedUnrefreshed"));
              });
          }
        },
        controller.signal,
      )
      .catch((error) => {
        if (this.closed || controller.signal.aborted) return;
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "IMAGE_EVENT_GAP"
        )
          void recover();
        else {
          this.streams.delete(job.id);
          this.notice(message("imageStudio.notice.warning.streamInterrupted"));
        }
      })
      .then(() => {
        if (!recovering && this.streams.get(job.id) === controller) {
          this.streams.delete(job.id);
          if (
            !this.closed &&
            !controller.signal.aborted &&
            !terminalJob(this.read().jobs[job.id] ?? job)
          )
            this.notice(message("imageStudio.notice.warning.streamEnded"));
        }
      });
  }
}
