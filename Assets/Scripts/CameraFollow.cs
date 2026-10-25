using UnityEngine;

// Caméra qui suit le joueur. Clic droit + souris ou Q/E pour tourner autour.
public class CameraFollow : MonoBehaviour
{
    public Transform target;
    public Vector3 offset = new Vector3(0f, 8f, -11f);
    public float smooth = 6f;

    float yaw;
    float shake;

    public void Shake(float amount) => shake = Mathf.Max(shake, amount);

    void LateUpdate()
    {
        if (target == null) return;

        yaw += MobileInput.CameraDelta;
        if (Input.GetMouseButton(1)) yaw += Input.GetAxis("Mouse X") * 4f;
        if (Input.GetKey(KeyCode.Q)) yaw -= 100f * Time.deltaTime;
        if (Input.GetKey(KeyCode.E)) yaw += 100f * Time.deltaTime;

        Vector3 desired = target.position + Quaternion.Euler(0f, yaw, 0f) * offset;
        transform.position = Vector3.Lerp(transform.position, desired, 1f - Mathf.Exp(-smooth * Time.deltaTime));
        transform.LookAt(target.position + Vector3.up);

        if (shake > 0f)
        {
            transform.position += Random.insideUnitSphere * shake;
            shake = Mathf.MoveTowards(shake, 0f, Time.deltaTime * 2f);
        }
    }
}
