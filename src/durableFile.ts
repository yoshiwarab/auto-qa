import { open } from "node:fs/promises";

export const writeFileDurably = async (
  path: string,
  contents: string,
): Promise<void> => {
  const file = await open(path, "w");
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
};

export const syncDirectory = async (
  path: string,
): Promise<void> => {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};
