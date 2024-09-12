import { Button } from "@cap/ui-solid";
import { createElementBounds } from "@solid-primitives/bounds";
import { trackDeep } from "@solid-primitives/deep";
import { throttle } from "@solid-primitives/scheduled";
import { useSearchParams } from "@solidjs/router";
import { cx } from "cva";
import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createEffect,
  createMemo,
  createResource,
  createRoot,
  createSignal,
  on,
  onMount,
} from "solid-js";
import { platform } from "@tauri-apps/plugin-os";
import { createStore, reconcile } from "solid-js/store";

import { events, type RenderProgress, commands } from "../../utils/tauri";
import { EditorContextProvider, useEditorContext } from "./context";
import {
  Dialog,
  DialogContent,
  EditorButton,
  Input,
  Subfield,
  Toggle,
} from "./ui";

export function Editor() {
  const [params] = useSearchParams<{ id: string }>();

  return (
    <Show when={params.id} fallback="No video id available" keyed>
      {(videoId) => (
        <EditorInstanceContextProvider videoId={videoId}>
          <Show
            when={(() => {
              const ctx = useEditorInstanceContext();
              const editorInstance = ctx.editorInstance();
              const presets = ctx.presets.query();

              if (!editorInstance || !presets) return;
              return { editorInstance, presets };
            })()}
          >
            {(values) => (
              <EditorContextProvider {...values()}>
                <Inner />
              </EditorContextProvider>
            )}
          </Show>
        </EditorInstanceContextProvider>
      )}
    </Show>
  );
}

function Inner() {
  const {
    project,
    videoId,
    editorInstance,
    playbackTime,
    setPlaybackTime,
    playing,
    setPlaying,
    previewTime,
  } = useEditorContext();

  onMount(() => {
    events.editorStateChanged.listen((e) => {
      renderFrame.clear();
      setPlaybackTime(e.payload.playhead_position / 30);
    });
  });

  const renderFrame = throttle((time: number) => {
    events.renderFrameEvent.emit({
      frame_number: Math.floor(time * 30),
      project: project,
    });
  }, 1000 / 60);

  const frameNumberToRender = createMemo(() => {
    const preview = previewTime();
    if (preview !== undefined) return preview;
    return playbackTime();
  });

  createEffect(
    on(frameNumberToRender, (number) => {
      if (playing()) return;
      renderFrame(number);
    })
  );

  createEffect(
    on(
      () => {
        trackDeep(project);
      },
      () => {
        renderFrame(playbackTime());
      }
    )
  );

  const togglePlayback = async () => {
    try {
      if (playing()) {
        await commands.stopPlayback(videoId);
        setPlaying(false);
      } else {
        await commands.startPlayback(videoId, project);
        setPlaying(true);
      }
    } catch (error) {
      console.error("Error toggling playback:", error);
      setPlaying(false);
    }
  };

  createEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        await togglePlayback();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  });

  return (
    <div
      class="p-5 flex flex-col gap-4 w-screen h-screen divide-y bg-gray-50 rounded-lg leading-5 animate-in fade-in"
      data-tauri-drag-region
    >
      <Header />
      <div class="rounded-2xl shadow border flex-1 flex flex-col divide-y bg-white">
        <div class="flex flex-row flex-1 divide-x overflow-y-hidden">
          <Player />
          <ConfigSidebar />
        </div>
        <Timeline />
      </div>
      <Dialogs />
    </div>
  );
}

function Header() {
  const [os] = createResource(() => platform());

  return (
    <header
      class={cx(
        "flex flex-row justify-between items-center",
        os() === "macos" && "pl-[4.3rem]"
      )}
      data-tauri-drag-region
    >
      <div class="flex flex-row items-center gap-[0.5rem] text-[0.875rem]">
        <div class="flex flex-row items-center gap-[0.375rem]">
          <div class="size-[1.5rem] rounded-[0.25rem] bg-gray-500 bg-black" />
          <span>My Workspace</span>
        </div>
        <span class="text-gray-400">/</span>
        <div class="flex flex-row items-center gap-[0.375rem]">
          <span>Cap Title</span>
        </div>
      </div>
      <div
        class="flex flex-row gap-4 font-medium items-center"
        data-tauri-drag-region
      >
        <ShareButton />
        <ExportButton />
      </div>
    </header>
  );
}

import { createEventListenerMap } from "@solid-primitives/event-listener";
import { Channel, convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  EditorInstanceContextProvider,
  useEditorInstanceContext,
} from "./editorInstanceContext";
import { DEFAULT_PROJECT_CONFIG } from "./projectConfig";
import { createMutation } from "@tanstack/solid-query";
import { ConfigSidebar } from "./ConfigSidebar";
import { Player } from "./Player";
import { formatTime } from "./utils";

function ExportButton() {
  const { videoId, project } = useEditorContext();

  const [state, setState] = createStore<
    | { open: false; type: "idle" }
    | ({ open: boolean } & (
        | { type: "inProgress"; progress: number; totalFrames: number }
        | { type: "finished"; path: string }
      ))
  >({ open: false, type: "idle" });

  return (
    <>
      <Button
        variant="primary"
        size="md"
        onClick={() => {
          save({
            filters: [{ name: "mp4 filter", extensions: ["mp4"] }],
          }).then((p) => {
            if (!p) return;

            setState(
              reconcile({
                open: true,
                type: "inProgress",
                progress: 0,
                totalFrames: 0,
              })
            );

            const progress = new Channel<RenderProgress>();
            progress.onmessage = (p) => {
              if (p.type === "FrameRendered" && state.type === "inProgress")
                setState({ progress: p.current_frame });
              if (
                p.type === "EstimatedTotalFrames" &&
                state.type === "inProgress"
              ) {
                console.log("Total frames: ", p.total_frames);
                setState({ totalFrames: p.total_frames });
              }
            };

            return commands
              .renderToFile(p, videoId, project, progress)
              .then(() => {
                setState({ ...state, type: "finished", path: p });
              });
          });
        }}
      >
        Export
      </Button>
      <Dialog.Root
        open={state.open}
        onOpenChange={(o) => {
          if (!o) setState(reconcile({ ...state, open: false }));
        }}
      >
        <DialogContent
          title="Export Recording"
          confirm={
            <Show when={state.type === "finished" && state}>
              {(state) => (
                <Button
                  onClick={() => {
                    commands.openInFinder(state().path);
                  }}
                >
                  Open in Finder
                </Button>
              )}
            </Show>
          }
        >
          <Switch>
            <Match when={state.type === "finished"}>Finished exporting</Match>
            <Match when={state.type === "inProgress" && state}>
              {(state) => (
                <>
                  <div class="w-full bg-gray-200 rounded-full h-2.5">
                    <div
                      class="bg-blue-300 h-2.5 rounded-full"
                      style={{
                        width: `${Math.min(
                          (state().progress / (state().totalFrames || 1)) * 100,
                          100
                        )}%`,
                      }}
                    />
                  </div>
                </>
              )}
            </Match>
          </Switch>
        </DialogContent>
      </Dialog.Root>
    </>
  );
}

function ShareButton() {
  const { videoId, presets } = useEditorContext();
  const [meta, metaActions] = createResource(() =>
    commands.getRecordingMeta(videoId)
  );

  const uploadVideo = createMutation(() => ({
    mutationFn: async () => {
      const res = await commands.uploadRenderedVideo(
        videoId,
        presets.getDefaultConfig() ?? DEFAULT_PROJECT_CONFIG
      );
      if (res.status !== "ok") throw new Error(res.error);
    },
    onSuccess: () => metaActions.refetch(),
  }));

  return (
    <Show
      when={meta()?.sharing}
      fallback={
        <Button
          disabled={uploadVideo.isPending}
          onClick={() => uploadVideo.mutate()}
          class="flex items-center space-x-1"
        >
          {uploadVideo.isPending ? (
            <>
              <span>Uploading Cap</span>
              <IconLucideLoaderCircle class="size-[1rem] animate-spin" />
            </>
          ) : (
            "Create Shareable Link"
          )}
        </Button>
      }
    >
      {(sharing) => {
        const url = () => new URL(sharing().link);

        return (
          <a
            class="rounded-full h-[2rem] px-[1rem] flex flex-row items-center gap-[0.375rem] bg-gray-200 hover:bg-gray-300 transition-colors duration-100"
            href={sharing().link}
            target="_blank"
            rel="noreferrer"
          >
            <span class="text-[0.875rem] text-gray-500">
              {url().host}
              {url().pathname}
            </span>
          </a>
        );
      }}
    </Show>
  );
}

function Timeline() {
  const {
    project,
    videoId,
    editorInstance,
    playbackTime,
    setPlaybackTime,
    playing,
    setPlaying,
    previewTime,
    setPreviewTime,
  } = useEditorContext();

  const duration = () => editorInstance.recordingDuration;

  const [timelineRef, setTimelineRef] = createSignal<HTMLDivElement>();
  const timelineBounds = createElementBounds(timelineRef);

  return (
    <div class="px-[0.75rem] py-[2rem] relative">
      <Show when={previewTime()}>
        {(time) => (
          <div
            class="w-px bg-black-transparent-20 absolute left-5 top-4 bottom-0 z-10 pointer-events-none"
            style={{
              transform: `translateX(${
                (time() / duration()) * (timelineBounds.width ?? 0)
              }px)`,
            }}
          >
            <div class="size-2 bg-black-transparent-20 rounded-full -mt-2 -ml-[calc(0.25rem-0.5px)]" />
          </div>
        )}
      </Show>
      <div
        class="w-px bg-red-300 absolute left-5 top-4 bottom-0 z-10"
        style={{
          transform: `translateX(${
            (playbackTime() / duration()) * (timelineBounds.width ?? 0)
          }px)`,
        }}
      >
        <div class="size-2 bg-red-300 rounded-full -mt-2 -ml-[calc(0.25rem-0.5px)]" />
      </div>
      <div class="relative h-[3rem] border border-white ring-1 ring-blue-300 flex flex-row rounded-xl overflow-hidden">
        <div class="bg-blue-300 w-[0.5rem]" />
        <div
          ref={setTimelineRef}
          class="bg-blue-50 relative w-full h-full flex flex-row items-end justify-end px-[0.5rem] py-[0.25rem]"
          onMouseDown={(e) => {
            const { left, width } = e.currentTarget.getBoundingClientRect();
            commands.setPlayheadPosition(
              videoId,
              Math.round(30 * duration() * ((e.clientX - left) / width))
            );
          }}
          onMouseMove={(e) => {
            const { left, width } = e.currentTarget.getBoundingClientRect();
            setPreviewTime(
              Math.max(duration() * ((e.clientX - left) / width), 0)
            );
          }}
          onMouseLeave={() => {
            setPreviewTime(undefined);
          }}
        >
          <span class="text-black-transparent-60 text-[0.625rem]">0:00</span>
          <span class="text-black-transparent-60 text-[0.625rem] ml-auto">
            {formatTime(duration())}
          </span>
        </div>
        <div class="bg-blue-300 w-[0.5rem]" />
      </div>
    </div>
  );
}

function Dialogs() {
  const { dialog, setDialog, presets, project } = useEditorContext();

  return (
    <Dialog.Root
      size={(() => {
        const d = dialog();
        if (!d.open) return "sm";
        return d.type === "crop" ? "lg" : "sm";
      })()}
      open={dialog().open}
      onOpenChange={(o) => {
        if (!o) setDialog((d) => ({ ...d, open: false }));
      }}
    >
      <Show
        when={(() => {
          const d = dialog();
          if ("type" in d) return d;
        })()}
      >
        {(dialog) => (
          <Switch>
            <Match when={dialog().type === "createPreset"}>
              {(_) => {
                const [form, setForm] = createStore({
                  name: "",
                  default: false,
                });

                const createPreset = createMutation(() => ({
                  mutationFn: async () =>
                    presets.createPreset({ ...form, config: project }),
                  onSuccess: () => {
                    setDialog((d) => ({ ...d, open: false }));
                  },
                }));

                return (
                  <DialogContent
                    title="Create Preset"
                    confirm={
                      <Dialog.ConfirmButton
                        disabled={createPreset.isPending}
                        onClick={() => createPreset.mutate()}
                      >
                        Create
                      </Dialog.ConfirmButton>
                    }
                  >
                    <Subfield name="Name" required />
                    <Input
                      class="mt-[0.25rem]"
                      value={form.name}
                      onInput={(e) => setForm("name", e.currentTarget.value)}
                    />
                    <Subfield name="Set as default" class="mt-[0.75rem]">
                      <Toggle
                        checked={form.default}
                        onChange={(checked) => setForm("default", checked)}
                      />
                    </Subfield>
                  </DialogContent>
                );
              }}
            </Match>
            <Match
              when={(() => {
                const d = dialog();
                if (d.type === "renamePreset") return d;
              })()}
            >
              {(dialog) => {
                const [name, setName] = createSignal(
                  presets.query()?.presets[dialog().presetIndex].name!
                );

                const renamePreset = createMutation(() => ({
                  mutationFn: async () =>
                    presets.renamePreset(dialog().presetIndex, name()),
                  onSuccess: () => {
                    setDialog((d) => ({ ...d, open: false }));
                  },
                }));

                return (
                  <DialogContent
                    title="Rename Preset"
                    confirm={
                      <Dialog.ConfirmButton
                        disabled={renamePreset.isPending}
                        onClick={() => renamePreset.mutate()}
                      >
                        Rename
                      </Dialog.ConfirmButton>
                    }
                  >
                    <Subfield name="Name" required />
                    <Input
                      value={name()}
                      onInput={(e) => setName(e.currentTarget.value)}
                    />
                  </DialogContent>
                );
              }}
            </Match>
            <Match
              when={(() => {
                const d = dialog();
                if (d.type === "deletePreset") return d;
              })()}
            >
              {(dialog) => {
                const deletePreset = createMutation(() => ({
                  mutationFn: async () =>
                    presets.deletePreset(dialog().presetIndex),
                  onSuccess: () => {
                    setDialog((d) => ({ ...d, open: false }));
                  },
                }));

                return (
                  <DialogContent
                    title="Delete Preset"
                    confirm={
                      <Dialog.ConfirmButton
                        variant="destructive"
                        onClick={() => deletePreset.mutate()}
                        disabled={deletePreset.isPending}
                      >
                        Delete
                      </Dialog.ConfirmButton>
                    }
                  >
                    <p class="text-gray-400">
                      Lorem ipsum dolor sit amet, consectetur adipiscing elit
                      sed do eiusmod tempor incididunt ut labore et dolore magna
                      aliqua.
                    </p>
                  </DialogContent>
                );
              }}
            </Match>
            <Match
              when={(() => {
                const d = dialog();
                if (d.type === "crop") return d;
              })()}
            >
              {(dialog) => {
                const { setProject: setState, editorInstance } =
                  useEditorContext();
                const [crop, setCrop] = createStore({
                  position: dialog().position,
                  size: dialog().size,
                });

                const display = editorInstance.recordings.display;

                const styles = createMemo(() => {
                  return {
                    left: `${(crop.position.x / display.width) * 100}%`,
                    top: `${(crop.position.y / display.height) * 100}%`,
                    right: `calc(${
                      ((display.width - crop.size.x - crop.position.x) /
                        display.width) *
                      100
                    }%)`,
                    bottom: `calc(${
                      ((display.height - crop.size.y - crop.position.y) /
                        display.height) *
                      100
                    }%)`,
                  };
                });

                let cropAreaRef: HTMLDivElement;
                let cropTargetRef: HTMLDivElement;

                return (
                  <>
                    <Dialog.Header>
                      <div class="flex flex-row space-x-[0.75rem]">
                        <AspectRatioSelect />
                        <div class="flex flex-row items-center space-x-[0.5rem] text-gray-400">
                          <span>Size</span>
                          <div class="w-[3.25rem]">
                            <Input value={crop.size.x} disabled />
                          </div>
                          <span>x</span>
                          <div class="w-[3.25rem]">
                            <Input value={crop.size.y} disabled />
                          </div>
                        </div>
                        <div class="flex flex-row items-center space-x-[0.5rem] text-gray-400">
                          <span>Position</span>
                          <div class="w-[3.25rem]">
                            <Input value={crop.position.x} disabled />
                          </div>
                          <span>x</span>
                          <div class="w-[3.25rem]">
                            <Input
                              class="w-[3.25rem]"
                              value={crop.position.y}
                              disabled
                            />
                          </div>
                        </div>
                      </div>
                      <EditorButton
                        leftIcon={<IconCapCircleX />}
                        class="ml-auto"
                        onClick={() =>
                          setCrop({
                            position: { x: 0, y: 0 },
                            size: {
                              x: editorInstance.recordings.display.width,
                              y: editorInstance.recordings.display.height,
                            },
                          })
                        }
                      >
                        Reset
                      </EditorButton>
                    </Dialog.Header>
                    <Dialog.Content>
                      <div
                        class="relative"
                        // biome-ignore lint/style/noNonNullAssertion: ref
                        ref={cropAreaRef!}
                      >
                        <div class="divide-black-transparent-10 overflow-hidden rounded-lg">
                          <img
                            class="shadow pointer-events-none"
                            alt="screenshot"
                            src={convertFileSrc(
                              `${editorInstance.path}/screenshots/display.jpg`
                            )}
                          />
                        </div>
                        <div
                          class="bg-white-transparent-20 absolute cursor-move"
                          // biome-ignore lint/style/noNonNullAssertion: ref
                          ref={cropTargetRef!}
                          style={styles()}
                          onMouseDown={(downEvent) => {
                            const original = {
                              position: { ...crop.position },
                              size: { ...crop.size },
                            };

                            createRoot((dispose) => {
                              createEventListenerMap(window, {
                                mouseup: () => dispose(),
                                mousemove: (moveEvent) => {
                                  const diff = {
                                    x:
                                      ((moveEvent.clientX - downEvent.clientX) /
                                        cropAreaRef.clientWidth) *
                                      display.width,
                                    y:
                                      ((moveEvent.clientY - downEvent.clientY) /
                                        cropAreaRef.clientHeight) *
                                      display.height,
                                  };

                                  batch(() => {
                                    if (original.position.x + diff.x < 0)
                                      setCrop("position", "x", 0);
                                    else if (
                                      original.position.x + diff.x >
                                      display.width - crop.size.x
                                    )
                                      setCrop(
                                        "position",
                                        "x",
                                        display.width - crop.size.x
                                      );
                                    else
                                      setCrop(
                                        "position",
                                        "x",
                                        original.position.x + diff.x
                                      );

                                    if (original.position.y + diff.y < 0)
                                      setCrop("position", "y", 0);
                                    else if (
                                      original.position.y + diff.y >
                                      display.height - crop.size.y
                                    )
                                      setCrop(
                                        "position",
                                        "y",
                                        display.height - crop.size.y
                                      );
                                    else
                                      setCrop(
                                        "position",
                                        "y",
                                        original.position.y + diff.y
                                      );
                                  });
                                },
                              });
                            });
                          }}
                        >
                          <For
                            each={Array.from({ length: 4 }, (_, i) => ({
                              x: i < 2 ? ("l" as const) : ("r" as const),
                              y: i % 2 === 0 ? ("t" as const) : ("b" as const),
                            }))}
                          >
                            {(pos) => {
                              const behaviours = {
                                x:
                                  pos.x === "l"
                                    ? ("both" as const)
                                    : ("resize" as const),
                                y:
                                  pos.y === "t"
                                    ? ("both" as const)
                                    : ("resize" as const),
                              };

                              return (
                                <button
                                  type="button"
                                  class="absolute"
                                  style={{
                                    ...(pos.x === "l"
                                      ? { left: "0px" }
                                      : { right: "0px" }),
                                    ...(pos.y === "t"
                                      ? { top: "0px" }
                                      : { bottom: "0px" }),
                                  }}
                                  onMouseDown={(downEvent) => {
                                    downEvent.stopPropagation();

                                    const original = {
                                      position: { ...crop.position },
                                      size: { ...crop.size },
                                    };

                                    const MIN_SIZE = 100;

                                    createRoot((dispose) => {
                                      createEventListenerMap(window, {
                                        mouseup: () => dispose(),
                                        mousemove: (moveEvent) => {
                                          batch(() => {
                                            const diff = {
                                              x:
                                                ((moveEvent.clientX -
                                                  downEvent.clientX) /
                                                  cropAreaRef.clientWidth) *
                                                display.width,
                                              y:
                                                ((moveEvent.clientY -
                                                  downEvent.clientY) /
                                                  cropAreaRef.clientHeight) *
                                                display.height,
                                            };

                                            if (behaviours.x === "resize") {
                                              setCrop(
                                                "size",
                                                "x",
                                                clamp(
                                                  original.size.x + diff.x,
                                                  MIN_SIZE,
                                                  editorInstance.recordings
                                                    .display.width -
                                                    crop.position.x
                                                )
                                              );
                                            } else {
                                              setCrop(
                                                "position",
                                                "x",
                                                clamp(
                                                  original.position.x + diff.x,
                                                  0,
                                                  editorInstance.recordings
                                                    .display.width - MIN_SIZE
                                                )
                                              );
                                              setCrop(
                                                "size",
                                                "x",
                                                clamp(
                                                  original.size.x - diff.x,
                                                  MIN_SIZE,
                                                  editorInstance.recordings
                                                    .display.width
                                                )
                                              );
                                            }

                                            if (behaviours.y === "resize") {
                                              setCrop(
                                                "size",
                                                "y",
                                                clamp(
                                                  original.size.y + diff.y,
                                                  MIN_SIZE,
                                                  editorInstance.recordings
                                                    .display.height -
                                                    crop.position.y
                                                )
                                              );
                                            } else {
                                              setCrop(
                                                "position",
                                                "y",
                                                clamp(
                                                  original.position.y + diff.y,
                                                  0,
                                                  editorInstance.recordings
                                                    .display.height - MIN_SIZE
                                                )
                                              );
                                              setCrop(
                                                "size",
                                                "y",
                                                clamp(
                                                  original.size.y - diff.y,
                                                  MIN_SIZE,
                                                  editorInstance.recordings
                                                    .display.height
                                                )
                                              );
                                            }
                                          });
                                        },
                                      });
                                    });
                                  }}
                                >
                                  <div class="size-[1rem] bg-gray-500 border border-gray-50 rounded-full absolute -top-[0.5rem] -left-[0.5rem]" />
                                </button>
                              );
                            }}
                          </For>
                        </div>
                      </div>
                    </Dialog.Content>
                    <Dialog.Footer>
                      <Button
                        onClick={() => {
                          setState("background", "crop", crop);
                          setDialog((d) => ({ ...d, open: false }));
                        }}
                      >
                        Save
                      </Button>
                    </Dialog.Footer>
                  </>
                );
              }}
            </Match>
          </Switch>
        )}
      </Show>
    </Dialog.Root>
  );
}

function clamp(n: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}
