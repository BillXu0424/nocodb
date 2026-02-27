#!/bin/bash
# script to build local docker image.
# highlevel steps involved
# 1. Stop and remove existing container and image
# 2. Install dependencies
# 3. Build nc-gui
#   3a. static build of nc-gui
#   3b. copy nc-gui build to nocodb dir
# 4. Build nocodb

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
LOG_FILE=${SCRIPT_DIR}/build-local-docker-image.log
ERROR=""

function stop_and_remove_container() {
    # Stop and remove the existing container
    docker stop nocodb-local >/dev/null 2>&1
    docker rm nocodb-local >/dev/null 2>&1
}

function remove_image() {
    # Remove the existing image
    docker rmi nocodb-local >/dev/null 2>&1
}

function install_dependencies() {
    # Install all dependencies
    cd ${SCRIPT_DIR}
    pnpm bootstrap || ERROR="install_dependencies failed"
}

function build_gui() {
    # build nc-gui
    export NODE_OPTIONS="--max_old_space_size=16384"
    # generate static build of nc-gui
    cd ${SCRIPT_DIR}/packages/nc-gui
    pnpm run generate || ERROR="gui build failed"
}

function copy_gui_artifacts() {
     # copy nc-gui build to nocodb dir
    rsync -rvzh --delete ./dist/ ${SCRIPT_DIR}/packages/nocodb/docker/nc-gui/ || ERROR="copy_gui_artifacts failed"
}

function package_nocodb() {
    # build nocodb ( pack nocodb-sdk and nc-gui )
    cd ${SCRIPT_DIR}/packages/nocodb
    pnpm run docker:build || ERROR="package_nocodb failed"
}

function build_image() {
    # build docker
    # 无法访问 Docker Hub 时：
    #   1. 在有网络机器：docker pull --platform linux/amd64 node:22-slim && docker save -o node-22-slim.tar node:22-slim
    #   2. 传到本机后：docker load -i node-22-slim.tar
    #   3. 执行：DOCKER_BUILD_PULL=false DOCKER_PLATFORM=linux/amd64 ./build-local-docker-image.sh
    PLATFORM_ARG=""
    [[ -n "${DOCKER_PLATFORM}" ]] && PLATFORM_ARG="--platform ${DOCKER_PLATFORM}"
    PULL_ARG=""
    [[ "${DOCKER_BUILD_PULL}" == "false" ]] && PULL_ARG="--pull=false"

    # 预加载 node 镜像（可选）：DOCKER_NODE_IMAGE_TAR=/path/to/node-22-slim.tar
    if [[ -n "${DOCKER_NODE_IMAGE_TAR}" ]] && [[ -f "${DOCKER_NODE_IMAGE_TAR}" ]]; then
        echo "Info: Loading node base image from ${DOCKER_NODE_IMAGE_TAR}"
        docker load -i "${DOCKER_NODE_IMAGE_TAR}" || true
    fi

    docker build . -f Dockerfile.local -t nocodb-local:latest ${PLATFORM_ARG} ${PULL_ARG} || ERROR="build_image failed"
}

function log_message() {
    if [[ ${ERROR} != "" ]];
    then
        >&2 echo "build failed, Please check build-local-docker-image.log for more details"
        >&2 echo "ERROR: ${ERROR}"
        exit 1
    else
        echo 'docker image with tag "nocodb-local" built sussessfully. Use below sample command to run the container'
        echo 'docker run -d -p 3333:8080 --name nocodb-local nocodb-local '
    fi
}

echo "Info: Stopping and removing existing container and image" | tee ${LOG_FILE}
stop_and_remove_container
remove_image

echo "Info: Installing dependencies" | tee -a ${LOG_FILE}
install_dependencies 1>> ${LOG_FILE} 2>> ${LOG_FILE}

echo "Info: Building nc-gui" | tee -a ${LOG_FILE}
build_gui 1>> ${LOG_FILE} 2>> ${LOG_FILE}

echo "Info: Copy nc-gui build to nocodb dir" | tee -a ${LOG_FILE}
copy_gui_artifacts 1>> ${LOG_FILE} 2>> ${LOG_FILE}

echo "Info: Build nocodb, package nocodb-sdk and nc-gui" | tee -a ${LOG_FILE}
package_nocodb 1>> ${LOG_FILE} 2>> ${LOG_FILE}

if [[ ${ERROR} == "" ]]; then
    echo "Info: Building docker image" | tee -a ${LOG_FILE}
    build_image 1>> ${LOG_FILE} 2>> ${LOG_FILE}
fi

log_message | tee -a ${LOG_FILE}
