import { openDB, type IDBPDatabase } from 'idb';
import type { MediaItem, Project } from '../types';
import { deletePath } from './opfs';

let dbp: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB('clap', 1, {
      upgrade(d) {
        d.createObjectStore('projects', { keyPath: 'id' });
        const m = d.createObjectStore('media', { keyPath: 'id' });
        m.createIndex('projectId', 'projectId');
        d.createObjectStore('assets');
      },
    });
  }
  return dbp;
}

export async function listProjects(): Promise<Project[]> {
  const all = (await (await db()).getAll('projects')) as Project[];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | undefined> {
  return (await db()).get('projects', id) as Promise<Project | undefined>;
}

export async function saveProject(p: Project): Promise<void> {
  await (await db()).put('projects', p);
}

export async function putMedia(m: MediaItem): Promise<void> {
  await (await db()).put('media', m);
}

export async function mediaForProject(projectId: string): Promise<MediaItem[]> {
  return (await (await db()).getAllFromIndex('media', 'projectId', projectId)) as MediaItem[];
}

export async function putAsset(key: string, value: unknown): Promise<void> {
  await (await db()).put('assets', value, key);
}

export async function getAsset<T>(key: string): Promise<T | undefined> {
  return (await db()).get('assets', key) as Promise<T | undefined>;
}

export async function deleteAsset(key: string): Promise<void> {
  await (await db()).delete('assets', key);
}

export async function deleteMediaItem(m: MediaItem): Promise<void> {
  const d = await db();
  await d.delete('media', m.id);
  await d.delete('assets', `thumbs:${m.id}`);
  await d.delete('assets', `peaks:${m.id}`);
  await deletePath(`media/${m.id}`);
  await deletePath(`audio/${m.id}`);
}

export async function deleteProject(id: string): Promise<void> {
  const media = await mediaForProject(id);
  for (const m of media) await deleteMediaItem(m);
  await (await db()).delete('assets', `cover:${id}`);
  await (await db()).delete('projects', id);
}
