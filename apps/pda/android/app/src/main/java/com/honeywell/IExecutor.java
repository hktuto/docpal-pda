package com.honeywell;

import android.os.Binder;
import android.os.IBinder;
import android.os.IInterface;
import android.os.Parcel;
import android.os.Parcelable;
import android.os.RemoteException;

/**
 * Faithful recreation of the Honeywell DCS AIDL (descriptor
 * "com.honeywell.IExecutor", 2 transactions), recreated without the AIDL
 * toolchain. Parcel logic is the inline equivalent of the generated _Parcel
 * helper in the decompiled original.
 */
public interface IExecutor extends IInterface {

    String DESCRIPTOR = "com.honeywell.IExecutor";

    Message execute(Message message) throws RemoteException;

    void executeAsync(Message message, IExecutor callback) throws RemoteException;

    abstract class Stub extends Binder implements IExecutor {

        static final int TRANSACTION_execute = 1;
        static final int TRANSACTION_executeAsync = 2;

        public Stub() {
            attachInterface(this, DESCRIPTOR);
        }

        public static IExecutor asInterface(IBinder binder) {
            if (binder == null) {
                return null;
            }
            IInterface local = binder.queryLocalInterface(DESCRIPTOR);
            if (local instanceof IExecutor) {
                return (IExecutor) local;
            }
            return new Proxy(binder);
        }

        @Override
        public IBinder asBinder() {
            return this;
        }

        @Override
        public boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
            if (code >= 1 && code <= 16777215) {
                data.enforceInterface(DESCRIPTOR);
            }
            if (code == IBinder.INTERFACE_TRANSACTION) {
                reply.writeString(DESCRIPTOR);
                return true;
            }
            if (code == TRANSACTION_execute) {
                Message result = execute(readTypedObject(data, Message.CREATOR));
                reply.writeNoException();
                writeTypedObject(reply, result, 1);
                return true;
            }
            if (code == TRANSACTION_executeAsync) {
                executeAsync(readTypedObject(data, Message.CREATOR), asInterface(data.readStrongBinder()));
                return true;
            }
            return super.onTransact(code, data, reply, flags);
        }

        private static class Proxy implements IExecutor {

            private final IBinder mRemote;

            Proxy(IBinder remote) {
                this.mRemote = remote;
            }

            @Override
            public IBinder asBinder() {
                return mRemote;
            }

            @Override
            public Message execute(Message message) throws RemoteException {
                Parcel data = Parcel.obtain();
                Parcel reply = Parcel.obtain();
                try {
                    data.writeInterfaceToken(DESCRIPTOR);
                    writeTypedObject(data, message, 0);
                    mRemote.transact(TRANSACTION_execute, data, reply, 0);
                    reply.readException();
                    return readTypedObject(reply, Message.CREATOR);
                } finally {
                    reply.recycle();
                    data.recycle();
                }
            }

            @Override
            public void executeAsync(Message message, IExecutor callback) throws RemoteException {
                Parcel data = Parcel.obtain();
                try {
                    data.writeInterfaceToken(DESCRIPTOR);
                    writeTypedObject(data, message, 0);
                    data.writeStrongBinder(callback != null ? callback.asBinder() : null);
                    mRemote.transact(TRANSACTION_executeAsync, data, null, IBinder.FLAG_ONEWAY);
                } finally {
                    data.recycle();
                }
            }
        }
    }

    static <T> T readTypedObject(Parcel parcel, Parcelable.Creator<T> creator) {
        if (parcel.readInt() != 0) {
            return creator.createFromParcel(parcel);
        }
        return null;
    }

    static <T extends Parcelable> void writeTypedObject(Parcel parcel, T value, int flags) {
        if (value != null) {
            parcel.writeInt(1);
            value.writeToParcel(parcel, flags);
        } else {
            parcel.writeInt(0);
        }
    }
}
