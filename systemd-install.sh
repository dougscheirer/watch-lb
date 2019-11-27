#!/bin/bash

cp ./systemd-script /etc/systemd/system/docker-compose@.service
systemctl daemon-reload
enable docker-compose@watch-lb
systemctl start docker-compose@watch-lb

