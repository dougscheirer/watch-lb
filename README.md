docker build -t dscheirer/watch-lb .
docker run [--network watch-lb] --env-file .env dscheirer/watch-lb
