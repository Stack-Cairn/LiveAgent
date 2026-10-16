import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import type { ExportDestination } from "../../lib/imaging/types";
import { AssetImage } from "./AssetImage";
import { selectClass } from "./ParamsBar";
import type { ImageStudioController, StudioView } from "./studioController";

export function ImageDetailPane({
  controller,
  view,
  exportDestinations,
  onCompare,
  onEdit,
}: {
  controller: ImageStudioController;
  view: StudioView;
  exportDestinations: readonly ExportDestination[];
  onCompare: (left: string, right: string) => void;
  onEdit: () => void;
}) {
  const id = view.state.selectedAssetId;
  const [destination, setDestination] = useState<ExportDestination | "">("");
  const [other, setOther] = useState("");
  const prefix = useId();
  const job = Object.values(view.state.jobs).find((job) => job.assetIds.includes(id ?? ""));
  if (!id || !job)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        选择图片查看版本详情、继续修改或导出。
      </div>
    );
  const parent = job.request.parentAssetId;
  const allAssets = [
    ...new Set(Object.values(view.state.jobs).flatMap((item) => item.assetIds)),
  ].filter((asset) => asset !== id);
  const comparison = other && allAssets.includes(other) ? other : (parent ?? allAssets[0]);
  const selectedDestination = exportDestinations.includes(destination as ExportDestination)
    ? (destination as ExportDestination)
    : exportDestinations[0];
  const destinationLabels = {
    download: "下载图片",
    local_workspace: "保存到本地工作区",
    remote_workspace: "保存到远程工作区",
  };
  return (
    <section aria-label="图片详情" className="space-y-4 p-4">
      <h2 className="text-sm font-semibold">图片详情</h2>
      <AssetImage
        client={controller.client}
        assetId={id}
        alt="当前选中的图片"
        className="max-h-64 w-full rounded-md object-contain"
      />
      <Button
        className="w-full"
        onClick={() => {
          controller.editAsset(id);
          onEdit();
        }}
      >
        以此图生成
      </Button>
      <dl className="space-y-2 text-xs">
        <div>
          <dt className="text-muted-foreground">模型</dt>
          <dd>{job.targetSnapshot.name}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">实际提示词</dt>
          <dd className="whitespace-pre-wrap break-words">{job.request.prompt}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">参数快照</dt>
          <dd>
            <ul>
              {Object.entries(job.request.parameters).map(([key, value]) => (
                <li key={key}>
                  {job.targetSnapshot.parameters.find((spec) => spec.key === key)?.label ?? key}：
                  {String(value)}
                </li>
              ))}
            </ul>
            {!Object.keys(job.request.parameters).length && "默认参数"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">用量费用</dt>
          <dd>
            {job.usage?.amount == null
              ? "未知"
              : `${job.usage.estimated ? "估算 " : ""}${job.usage.amount} ${job.usage.currency}`}
          </dd>
        </div>
      </dl>
      {parent && (
        <div className="space-y-1 text-xs">
          <p className="text-muted-foreground">父图片（原图保持不变）</p>
          <Button size="sm" variant="outline" onClick={() => controller.selectAsset(parent)}>
            查看父图片
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onCompare(parent, id)}>
            与父图片比较
          </Button>
        </div>
      )}
      {comparison && (
        <div className="space-y-2">
          <label htmlFor={`${prefix}-compare`} className="text-xs">
            比较版本
          </label>
          <select
            id={`${prefix}-compare`}
            className={selectClass}
            value={comparison}
            onChange={(event) => setOther(event.target.value)}
          >
            {[...new Set([...(parent ? [parent] : []), ...allAssets])].map((asset, index) => (
              <option key={asset} value={asset}>
                {asset === parent ? "父图片" : `结果 ${index + 1}`}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={() => onCompare(comparison, id)}>
            左右比较
          </Button>
        </div>
      )}
      {exportDestinations.length ? (
        <div className="space-y-2">
          <label htmlFor={`${prefix}-export`} className="text-xs">
            导出到
          </label>
          <select
            id={`${prefix}-export`}
            className={selectClass}
            value={selectedDestination}
            onChange={(event) => setDestination(event.target.value as ExportDestination)}
          >
            {exportDestinations.map((value) => (
              <option key={value} value={value}>
                {destinationLabels[value]}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (selectedDestination) void controller.exportAsset(id, selectedDestination);
            }}
          >
            导出当前图片
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">当前客户端未提供导出目的地。</p>
      )}
    </section>
  );
}
