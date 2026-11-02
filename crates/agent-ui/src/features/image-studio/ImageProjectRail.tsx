import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useLocale } from "../../i18n";
import type { ImageStudioController, StudioView } from "./studioController";
import { formatMessage, message } from "./studioText";

export function ImageProjectRail({
  controller,
  view,
}: {
  controller: ImageStudioController;
  view: StudioView;
}) {
  const [title, setTitle] = useState("");
  const [rename, setRename] = useState("");
  const [deleting, setDeleting] = useState(false);
  const id = useId();
  const { t } = useLocale();
  return (
    <nav aria-label={t("imageStudio.projects.label")} className="space-y-4 p-3">
      <h2 className="text-sm font-semibold">{t("imageStudio.projects.title")}</h2>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) {
            void controller.createProject(title);
            setTitle("");
          }
        }}
      >
        <label htmlFor={`${id}-title`} className="sr-only">
          {t("imageStudio.projects.newName")}
        </label>
        <Input
          id={`${id}-title`}
          value={title}
          placeholder={t("imageStudio.projects.newName")}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={!title.trim()}>
          {t("imageStudio.projects.create")}
        </Button>
      </form>
      <ul className="space-y-1">
        {view.state.projects.map((project) => (
          <li key={project.id}>
            <Button
              variant={project.id === view.projectId ? "secondary" : "ghost"}
              className="w-full justify-start overflow-hidden"
              aria-current={project.id === view.projectId ? "page" : undefined}
              onClick={() => {
                setDeleting(false);
                void controller.selectProject(project.id);
              }}
            >
              <span className="truncate">{project.title}</span>
            </Button>
          </li>
        ))}
      </ul>
      {view.projectCursor && (
        <Button size="sm" variant="ghost" onClick={() => void controller.moreProjects()}>
          {t("imageStudio.projects.loadMore")}
        </Button>
      )}
      {view.projectId && (
        <details>
          <summary className="cursor-pointer text-xs focus-visible:ring-2 focus-visible:ring-ring">
            {t("imageStudio.projects.manage")}
          </summary>
          <div className="space-y-2 pt-2">
            <label htmlFor={`${id}-rename`} className="sr-only">
              {t("imageStudio.projects.renameLabel")}
            </label>
            <Input
              id={`${id}-rename`}
              value={rename}
              placeholder={t("imageStudio.projects.renameLabel")}
              onChange={(event) => setRename(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!rename.trim()}
              onClick={() => void controller.renameProject(rename)}
            >
              {t("imageStudio.projects.rename")}
            </Button>
            {deleting ? (
              <div role="alert" className="space-y-2 text-xs">
                <p>{t("imageStudio.projects.deleteBody")}</p>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setDeleting(false);
                    void controller.deleteProject();
                  }}
                >
                  {t("imageStudio.projects.deleteConfirm")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeleting(false)}>
                  {t("imageStudio.projects.keep")}
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
                {t("imageStudio.projects.delete")}
              </Button>
            )}
          </div>
        </details>
      )}
      {view.draft.inputs.length > 0 && (
        <div>
          <h3 className="text-xs font-medium">{t("imageStudio.projects.assets")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatMessage(
              message("imageStudio.projects.assetsCount", { count: view.draft.inputs.length }),
              t,
            )}
          </p>
        </div>
      )}
    </nav>
  );
}
