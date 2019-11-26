docker build -t dscheirer/watch-lb .
docker run --env-file .env  dscheirer/watch-lb
