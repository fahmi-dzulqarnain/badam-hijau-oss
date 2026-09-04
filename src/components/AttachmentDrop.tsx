"use client";

import { useCallback, useRef, useState } from "react";
import { uploadAttachment } from "@/lib/editor/upload";
import { referenceFor } from "@/lib/editor/reference";

/**
 * `id` rather than `name` as the key: two files dropped together with the same name (two
 * screenshots both called `image.png`, saved from different apps) are legitimate, and keying
 * on the name would collide them into one row and one abort controller.
 */
type Job = { id: number; name: string; progress: number; error?: string };

/**
 * Paste, drag or pick a file; upload it; hand back the Markdown reference.
 *
 * Knows nothing about the editor beyond `onInsert`. The bytes go straight from here to the
 * store — this component never posts a file to this application.
 */
export function AttachmentDrop({
  pageId,
  onInsert,
  children,
}: {
  pageId: string;
  onInsert: (markdown: string) => void;
  children: React.ReactNode;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dragging, setDragging] = useState(false);
  const aborts = useRef(new Map<number, AbortController>());
  const nextJobId = useRef(0);

  const run = useCallback(
    async (files: File[]) => {
      // SEQUENTIAL, not concurrent. Four parallel 400MB uploads saturate the link and every
      // progress bar stalls together; one at a time is slower in aggregate and far more
      // legible to the person watching it.
      for (const file of files) {
        const id = ++nextJobId.current;
        const controller = new AbortController();
        aborts.current.set(id, controller);
        setJobs((current) => [...current, { id, name: file.name, progress: 0 }]);

        const result = await uploadAttachment(
          { pageId, file },
          {
            signal: controller.signal,
            onProgress: (fraction) =>
              setJobs((current) =>
                current.map((job) => (job.id === id ? { ...job, progress: fraction } : job)),
              ),
          },
        );
        aborts.current.delete(id);

        if (result.ok) {
          // A trailing newline, so the next paste does not concatenate onto this reference.
          onInsert(`${referenceFor(result.attachment)}\n`);
          setJobs((current) => current.filter((job) => job.id !== id));
        } else {
          // The server's wording, verbatim — it knows the cap and the allowlist. And the
          // loop continues: one refused file must not abandon the rest.
          setJobs((current) =>
            current.map((job) => (job.id === id ? { ...job, error: result.message } : job)),
          );
        }
      }
    },
    [pageId, onInsert],
  );

  return (
    <div
      className={dragging ? "ed-attach-drop ed-attach-drop--over" : "ed-attach-drop"}
      onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        // Files win over text. A screenshot pasted from the clipboard also carries an empty
        // `text/plain` part in several browsers, so taking the text first silently drops the
        // image — and the person sees nothing happen at all.
        if (files.length === 0) return;
        event.preventDefault();
        void run(files);
      }}
      onDragOver={(event) => {
        // Required on dragover as well as drop. Without it the browser NAVIGATES to the
        // dropped file and the draft is left behind unsaved.
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void run(Array.from(event.dataTransfer.files));
      }}
    >
      {children}

      <label className="ed-attach-pick">
        Attach a file
        <input
          type="file"
          multiple
          // The accessible name the e2e specs target, and the affordance for anyone who
          // cannot drag.
          aria-label="Attach a file"
          onChange={(event) => {
            void run(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </label>

      {jobs.length > 0 && (
        <ul className="ed-attach-jobs">
          {jobs.map((job) => (
            <li
              key={job.id}
              className={job.error ? "ed-attach-job ed-attach-job--error" : "ed-attach-job"}
            >
              <span className="ed-attach-job__name">{job.name}</span>
              {job.error ? (
                <>
                  <span role="alert">{job.error}</span>
                  <button
                    type="button"
                    onClick={() => setJobs((current) => current.filter((j) => j.id !== job.id))}
                  >
                    Dismiss
                  </button>
                </>
              ) : (
                <>
                  <progress value={job.progress} max={1} aria-label={`Uploading ${job.name}`} />
                  <button type="button" onClick={() => aborts.current.get(job.id)?.abort()}>
                    Cancel
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
