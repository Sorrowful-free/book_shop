-- Defense in depth: stock must never go negative. The CommitStock guarded
-- decrement (UPDATE … WHERE stock >= amount) already prevents it in code;
-- this constraint protects the invariant against any other write path.
ALTER TABLE "books" ADD CONSTRAINT "books_stock_non_negative" CHECK ("stock" >= 0);
