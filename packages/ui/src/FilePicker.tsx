// FilePicker. Presentational only: it holds the chosen files and shows them,
// it does not upload and it does not invent a stored path.
//
// That distinction matters here. A survey carries photographs of the business
// and a jaminan carries the document that proves ownership; a picker that
// reported a path before the file had actually been stored would put a
// filename on a record with nothing behind it. The caller uploads on submit
// and shows the real failure when the upload does not land.
import { useId, type ChangeEvent } from "react";
import { Icon } from "./Icon";

export interface FilePickerProps {
  label: string;
  files: readonly File[];
  onChange: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  hint?: string;
  disabled?: boolean;
  removeLabel?: string;
}

function ukuran(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function FilePicker({
  label,
  files,
  onChange,
  accept,
  multiple = true,
  hint,
  disabled = false,
  removeLabel = "Hapus dari daftar",
}: FilePickerProps) {
  const inputId = useId();

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.currentTarget.files ?? []);
    onChange(multiple ? [...files, ...picked] : picked.slice(0, 1));
    // Reset so picking the same file twice still fires a change.
    event.currentTarget.value = "";
  }

  return (
    <div className="filepicker">
      <label className="filepicker-trigger" htmlFor={inputId}>
        <Icon name="upload" size={18} />
        <span>{label}</span>
      </label>
      <input
        id={inputId}
        className="filepicker-input"
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={onPick}
      />
      {hint ? <p className="filepicker-hint">{hint}</p> : null}
      {files.length > 0 ? (
        <ul className="filepicker-list">
          {files.map((file, index) => (
            <li className="filepicker-item" key={`${file.name}-${index}`}>
              <Icon name="file" size={16} />
              <span className="filepicker-name">{file.name}</span>
              <span className="filepicker-size">{ukuran(file.size)}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`${removeLabel}: ${file.name}`}
                onClick={() => onChange(files.filter((_, at) => at !== index))}
              >
                <Icon name="close" size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
