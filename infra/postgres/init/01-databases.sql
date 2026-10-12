CREATE USER auth_user WITH PASSWORD 'auth_pass';
CREATE DATABASE auth_db OWNER auth_user;

CREATE USER catalog_user WITH PASSWORD 'catalog_pass';
CREATE DATABASE catalog_db OWNER catalog_user;

CREATE USER order_user WITH PASSWORD 'order_pass';
CREATE DATABASE order_db OWNER order_user;
