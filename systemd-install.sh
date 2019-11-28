#!/bin/bash

die() 
{
  echo "$*" && exit 1
}

# create the target directory for docker-compose targets?
mkdir -p /etc/docker/compose || die "Failed to create compose directory"

# always put a new script file in place
# $(which docker-compose) + sed to change systemd-script to real bin location on install
DCOMPLOC=$(which docker-compose)
# make the start script
sed "s/DCOMP/${DCOMPLOC//\//\\/}/g" ./systemd-script > /etc/systemd/system/docker-compose@.service
# cp ./systemd-script /etc/systemd/system/docker-compose@.service || die "Failed to copy service config"
# load new script
systemctl daemon-reload || die "Failed to reload systemctl"

# ln the docker-compose and .env-docker files to the target dir
mkdir -p /etc/docker/compose/watch-lb || die "Failed to create compose target dir"

[ ! -e /etc/docker/compose/watch-lb/docker-compose.yml ] && ln -s $(pwd)/docker-compose.yml /etc/docker/compose/watch-lb || die "Failed to link compose file"
[ ! -e /etc/docker/compose/watch-lb/.env-docker ] &&ln -s $(pwd)/.env-docker /etc/docker/compose/watch-lb || die "Failed to link .env file"

systemctl enable docker-compose@watch-lb || die "Failed to enable watch-lb"
systemctl start docker-compose@watch-lb || die "Faield to start watch-lb"

