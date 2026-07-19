"""Manual operations: /usr/bin/python3 -m docdoc.cli <command>

Commands:
  process <batch_dir>   run the pipeline on a directory of page images
  reindex               rebuild the FTS index
  stats                 archive statistics
"""

import json
import sys

from . import config, db, pipeline


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    cfg = config.load()
    con = db.connect()
    cmd, args = argv[0], argv[1:]
    if cmd == "process":
        for d in args:
            doc_id = pipeline.process_batch(cfg, con, d.rstrip("/"))
            print(f"-> document id {doc_id}")
        return 0
    if cmd == "reindex":
        con.execute("INSERT INTO doc_fts(doc_fts) VALUES('rebuild')")
        con.commit()
        print("FTS index rebuilt")
        return 0
    if cmd == "stats":
        for row in con.execute(
                """SELECT doc_type, COUNT(*) n FROM documents
                   WHERE status!='trash' GROUP BY doc_type ORDER BY n DESC"""):
            print(f"  {row['doc_type']:12s} {row['n']}")
        inv = con.execute(
            """SELECT COUNT(*) n, COALESCE(SUM(amount_due),0) s FROM invoices
               WHERE status IN ('open','reminded')""").fetchone()
        print(f"  unpaid invoices: {inv['n']} (total {inv['s']:.2f})")
        return 0
    print(f"unknown command {cmd!r}")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
