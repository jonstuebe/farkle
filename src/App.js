import React from 'react';

import './sass/App.scss';

const App = React.createClass({
    render() {
        return (
            <div>
                {React.cloneElement(this.props.children, {
                    key: this.props.location.pathname
                })}
            </div>
        )
    }
});

export default App
