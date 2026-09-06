FROM public.ecr.aws/lambda/python:3.12

# CloudShell has a very small Docker filesystem. Keep this image to a handful of
# layers so BuildKit does not exhaust local storage while snapshotting many tiny
# COPY steps.
COPY aws/mrms-publisher/requirements.txt \
     aws/mrms-publisher/handler_v2.py \
     aws/mrms-publisher/nexrad_publisher.py \
     aws/mrms-publisher/mrala_numeric_publisher.py \
     aws/mrms-publisher/handler_v3.py \
     ${LAMBDA_TASK_ROOT}/

RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# The radar source tree is small, so copy it in one layer. Then preserve the
# shared decoder/palette implementation as render_mrms_mosaic_base.py and expose
# the production display profile under the module name used by the publishers.
COPY scripts/radar/ ${LAMBDA_TASK_ROOT}/scripts/radar/
RUN cp ${LAMBDA_TASK_ROOT}/scripts/radar/render_mrms_mosaic.py \
       ${LAMBDA_TASK_ROOT}/scripts/radar/render_mrms_mosaic_base.py \
 && cp ${LAMBDA_TASK_ROOT}/scripts/radar/render_mrms_mosaic_display.py \
       ${LAMBDA_TASK_ROOT}/scripts/radar/render_mrms_mosaic.py

CMD ["handler.lambda_handler"]
