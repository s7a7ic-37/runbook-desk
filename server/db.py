from contextlib import contextmanager
from pathlib import Path

import psycopg
from psycopg.rows import dict_row


@contextmanager
def connection(database_url):
    with psycopg.connect(database_url, connect_timeout=5, row_factory=dict_row) as conn:
        yield conn


def initialize(database_url):
    with connection(database_url) as conn:
        conn.execute(Path(__file__).with_name('schema.sql').read_text())
