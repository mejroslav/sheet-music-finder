import initSqlJs, {
  type Database,
  type QueryExecResult,
  type Statement,
} from "sql.js";
import {
  getListFromAPI,
  ItemType,
  NUMBER_OF_AUTHOR_PAGES,
  NUMBER_OF_WORK_PAGES,
  type Author,
  type Item,
  type Work,
} from "./fetchFromAPI";
import { invoke } from "@tauri-apps/api/tauri";
import {
  createDir,
  exists,
  readBinaryFile,
  writeBinaryFile,
} from "@tauri-apps/api/fs";
import { Progress, PromiseWithProgress } from "./promiseWithProgress";

const dirname = (path: string) => path.substring(0, path.lastIndexOf("/"));

let _path: string | undefined;
async function getPath(): Promise<string> {
  if (!_path) {
    _path = await invoke<string>("get_sqlite_path");

    // make sure the directory exists
    const dir = dirname(await getPath());
    await createDir(dir, { recursive: true });
  }

  return _path;
}

let _SQL: initSqlJs.SqlJsStatic | null;

/**
 * Initialize SQLite.
 */
export async function getSQL() {
  if (_SQL) return _SQL;

  console.log("Initializing SQLite...");
  const SQL = await initSqlJs({
    locateFile: (file) => `https://sql.js.org/dist/${file}`,
  });

  return (_SQL = SQL);
}

let _database: Database | null;

/**
 * Create new SQL database and write it into a binary file.
 * @returns A SQL database.
 */
export async function createDatabase(): Promise<Database> {
  const SQL = await getSQL();

  console.log("Creating a new database...");
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE Authors (id text, type int, parent text, permlink text);"
  );
  db.run(
    "CREATE TABLE Works (id text, type int, parent text, permlink text, composer text, worktitle text, icatno text, pageid int);"
  );

  console.log("Database created! Writing it to disk...");
  const path = await getPath();
  await writeBinaryFile(path, db.export());
  console.log("Written to the disk, path: ", path);

  return (_database = db);
}

/**
 * Load a database if exists or create a new one.
 * @returns SQL Database.
 */
export async function loadOrCreateDatabase() {
  if (_database) return _database;
  const path = await getPath();

  if (await exists(path)) {
    console.log("Database exists! Attempting to load it...");
    const blob = await readBinaryFile(path);
    const SQL = await getSQL();
    return (_database = new SQL.Database(blob));
  }

  return await createDatabase();
}

/**
 * Checks whether the database
 * @returns
 */
export async function isDatabasePopulated(): Promise<boolean> {
  const db = await loadOrCreateDatabase();
  return (
    (db.exec("SELECT * FROM Authors LIMIT 1")?.[0]?.values?.length ?? -1) > 0 &&
    (db.exec("SELECT * FROM Works LIMIT 1")?.[0]?.values?.length ?? -1) > 0
  );
}

export function populateDatabase(): PromiseWithProgress<void> {
  return new PromiseWithProgress(async (res, { setRatio }, rej) => {
    // if we already have data, return
    if (await isDatabasePopulated()) return res();

    // else initiate scraping
    const authors = getListFromAPI(ItemType.Authors);
    const works = getListFromAPI(ItemType.Works);

    // mirror the progress
    const p = PromiseWithProgress.all<unknown>([NUMBER_OF_AUTHOR_PAGES, authors], [NUMBER_OF_WORK_PAGES, works]);
    p.subscribe(({ ratio }) => setRatio(ratio));
    p.then(() => res());
    p.catch(rej);

    // save the results to database
    authors.then(r => saveToDatabase(ItemType.Authors, r));
    works.then(r => saveToDatabase(ItemType.Works, r));
  });
}

/**
 * Write SQL data into a binary file. (Create a new one if necessary.)
 * @param t ItemType.Authors or ItemType.Works
 * @param items List of authors or compositions.
 */
export async function saveToDatabase<T extends ItemType>(
  t: T,
  items: Item<T>[]
) {
  console.log("Saving to the database...");
  const db = _database ?? (await loadOrCreateDatabase());

  let insert: Statement;
  let insertSuccessful = true;

  // Through list of Authors
  if (t === ItemType.Authors) {
    db.run("DELETE FROM Authors");
    insert = db.prepare(
      "INSERT INTO Authors VALUES ($id, $type, $parent, $permlink);"
    );
    for (const author of items as Author[]) {
      console.log(author, {
        $id: author.id,
        $type: author.type,
        $parent: author.parent,
        $permlink: author.permlink,
      });
      insertSuccessful &&= insert.bind({
        $id: author.id,
        $type: author.type,
        $parent: author.parent ?? "",
        $permlink: author.permlink,
      });
      insert.run();
    }
    // Through list of Works
  } else {
    db.run("DELETE FROM Works");
    insert = db.prepare(
      "INSERT INTO Works VALUES ($id, $type, $parent, $permlink, $composer, $worktitle, $icatno, $pageid);"
    );
    for (const work of items as Work[]) {
      console.log(work, {
        $id: work.id,
        $type: work.type,
        $parent: work.parent,
        $permlink: work.permlink,
        $composer: work.composer,
        $worktitle: work.worktitle,
        $icatno: work.icatno,
        $pagid: work.pageid,
      });
      insertSuccessful &&= insert.bind({
        $id: work.id,
        $type: work.type,
        $parent: work.parent ?? "",
        $permlink: work.permlink,
        $composer: work.composer,
        $worktitle: work.worktitle,
        $icatno: work.icatno,
        $pagid: work.pageid,
      });
      insert.run();
    }
  }

  insert.free(); // closing database

  if (!insertSuccessful) {
    throw new Error("nelze přidat do databáze");
  }

  console.log("Committing to disk...");
  const path = await getPath();
  await writeBinaryFile(path, db.export());
  console.log("Written to the disk, path: ", path);
}

function queryResultAsObject(result: QueryExecResult): any[] {
  if (result === undefined) return [];
  const objs: Record<any, any>[] = [];
  for (const row of result.values) {
    let obj: Record<any, any> = {};
    for (const [i, col] of result.columns.entries()) {
      obj[col] = row[i];
    }
    objs.push(obj);
  }

  return objs;
}

export function searchInDatabase(
  query: string,
  typeOfItems: ItemType.Authors
): Promise<Author[]>;
export function searchInDatabase(
  query: string,
  typeOfItems: ItemType.Works
): Promise<Work[]>;
export async function searchInDatabase(
  query: string,
  typeOfItems: ItemType
): Promise<Author[] | Work[]>;
export async function searchInDatabase(
  query: string,
  typeOfItems: ItemType
): Promise<Author[] | Work[]> {
  const db = await loadOrCreateDatabase();

  const escapedQuery = query.replaceAll(`'`, `''`);

  const table = typeOfItems === ItemType.Authors ? "Authors" : "Works";
  let search = db.exec(
    `SELECT * FROM ${table} WHERE id LIKE '%${escapedQuery}%' ORDER BY id LIMIT 10`
  )[0];

  return queryResultAsObject(search);
}

export async function findWorksFromAuthor(authorName: string) {
  const db = await loadOrCreateDatabase();
  let search = db.exec(
    `SELECT * FROM Works WHERE composer = '${authorName}' ORDER BY id`
  );

  return search.map(queryResultAsObject);
}